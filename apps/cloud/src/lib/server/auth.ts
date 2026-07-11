/**
 * Better Auth, instantiated per request (Workers bindings are per-request).
 *
 * PASSWORDLESS: the only credential surface is the magicLink plugin — enter an
 * email, receive a one-time link, click it, get a session. An unknown email
 * signs up on first use. There is NO email+password provider. GitHub OAuth is
 * still enabled only when GITHUB_CLIENT_ID/SECRET are both present.
 *
 * - drizzle adapter over the D1 control plane
 * - magic-link tokens: hashed at rest, single-use, ~15 min TTL (plugin opts)
 * - the `sendMagicLink` callback delivers via the Mailer (MailChannels in prod,
 *   DevMailer locally — see mailer.ts)
 * - sveltekitCookies must be the LAST plugin (per Better Auth docs)
 *
 * Fail-closed secret (audit MEDIUM): createAuth THROWS if BETTER_AUTH_SECRET is
 * missing when the origin is production; the dev fallback is allowed only under
 * import.meta.env.DEV.
 *
 * Production: BETTER_AUTH_URL=https://brainz.brownmatter.ai (wrangler secret).
 * Locally it may be unset — Better Auth then infers the base URL per request,
 * and both localhost origins are trusted.
 */
import { getRequestEvent } from "$app/server";
import type { CloudEnv } from "../../app.d";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { createDb, schema } from "./db";
import { createMailer, type Mailer } from "./mailer";

export const PRODUCTION_ORIGIN = "https://brainz.brownmatter.ai";

/** Magic links expire quickly — single-use handoff, not a standing credential. */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

/**
 * TTL for the server-minted verify URL the /claim/[token] APPROVE action
 * redirects the approving human's browser to (Wave G). This URL is never
 * emailed and NEVER handed to an agent — it exists only as the 303 Location
 * of the approve form response, consumed immediately by the same browser —
 * so a very short TTL suffices; 60 s comfortably covers slow redirects while
 * bounding any exposure. Per-request expiry is NOT supported by the installed
 * magicLink plugin (`expiresIn` is plugin-level only), so the minter builds a
 * separate auth instance pinned to this TTL — see createAuth's
 * `magicLinkTtlSeconds` override. (Replaces the retired agent `loginUrl`
 * minting: signup no longer returns a URL of any kind.)
 */
export const APPROVE_REDIRECT_TTL_SECONDS = 60;

/**
 * Idempotently decide whether a sign-in should flip `emailVerified` true.
 *
 * Clicking a magic link PROVES email ownership, so the first successful
 * magic-link sign-in is the honest moment to mark the account verified. Accounts
 * are provisioned with `emailVerified: false` (public-mcp.ts) and previously
 * nothing ever flipped it — so there was no signal distinguishing "a human
 * actually reached this account" from "an agent provisioned it and nobody showed
 * up".
 *
 * Returns true only when the user is currently unverified, so re-running is a
 * no-op (idempotent). Pure + exported for unit testing.
 *
 * NOTE: the installed Better Auth magicLink plugin ALSO flips emailVerified on
 * verify, but that is an undocumented library internal that has drifted across
 * versions. This hook makes the guarantee explicit in our own code and testable,
 * and is a safe no-op when the library has already done it.
 */
export function shouldMarkEmailVerified(user: { emailVerified?: boolean | null }): boolean {
  return user.emailVerified !== true;
}

const DEV_SECRET_FALLBACK = "dev-insecure-secret-change-me";

/**
 * Resolve the auth secret, failing closed in production. If BETTER_AUTH_SECRET
 * is set, use it. If it is missing, only the dev build may fall back to a fixed
 * insecure value; a production build (or one pinned to the production origin)
 * throws, so we never sign sessions/tokens with a guessable key.
 */
export function resolveSecret(env: CloudEnv): string {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  const isProdOrigin = env.BETTER_AUTH_URL === PRODUCTION_ORIGIN;
  // import.meta.env.DEV is true under vite dev; false in built/prod bundles.
  const isDev = Boolean(import.meta.env?.DEV) && !isProdOrigin;
  if (!isDev) {
    throw new Error(
      "BETTER_AUTH_SECRET is required in production — set it with `wrangler secret put BETTER_AUTH_SECRET`.",
    );
  }
  return DEV_SECRET_FALLBACK;
}

/**
 * @param mailerOverride When set, the magic-link callback delivers through this
 *   mailer instead of the env-selected one. The claim-approve minter passes a
 *   capturing mailer so it can redirect the approving browser to the verify
 *   URL rather than emailing it (see $lib/server/magic-link).
 * @param opts.magicLinkTtlSeconds Overrides the magic-link `expiresIn`. The
 *   claim-approve minter passes APPROVE_REDIRECT_TTL_SECONDS (far shorter than
 *   the emailed default — the URL is consumed by an immediate redirect).
 *   Defaults to MAGIC_LINK_TTL_SECONDS for the normal emailed flow.
 */
export function createAuth(
  env: CloudEnv,
  mailerOverride?: Mailer,
  opts?: { magicLinkTtlSeconds?: number },
) {
  const db = createDb(env.DB);
  const mailer = mailerOverride ?? createMailer(env);
  const magicLinkTtlSeconds = opts?.magicLinkTtlSeconds ?? MAGIC_LINK_TTL_SECONDS;
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : {};

  return betterAuth({
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    secret: resolveSecret(env),
    trustedOrigins: [
      PRODUCTION_ORIGIN,
      // Local dev: vite dev (5173), wrangler dev (8787), E2E harness (8788).
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://localhost:8788",
      "http://127.0.0.1:8788",
      ...(env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : []),
    ],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    // Flip emailVerified true the moment a session is created for a still-
    // unverified user. A session only ever follows a proven credential — a
    // magic-link verify or GitHub OAuth — so its creation is the honest signal
    // that a human reached the account (see shouldMarkEmailVerified). Runs
    // idempotently: no-op once the flag is already true, so repeat sign-ins and
    // the library's own verify-time flip don't double-write.
    databaseHooks: {
      session: {
        create: {
          async before(session, ctx) {
            // A session only ever follows a proven credential (magic-link verify
            // or GitHub OAuth), so look up its user and flip emailVerified true
            // if still false. findUserById + shouldMarkEmailVerified keep this
            // reliable (no dependence on ctx.context.session being populated
            // mid-creation) and idempotent (no-op once already verified).
            if (ctx && session.userId) {
              const found = await ctx.context.internalAdapter.findUserById(session.userId);
              if (found && shouldMarkEmailVerified(found)) {
                await ctx.context.internalAdapter.updateUser(session.userId, {
                  emailVerified: true,
                });
              }
            }
            // Return nothing → the session is created unchanged.
          },
        },
      },
    },
    socialProviders: github,
    plugins: [
      magicLink({
        expiresIn: magicLinkTtlSeconds,
        // Hash tokens at rest — the plaintext exists only inside the emailed URL.
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          // GRACEFUL DEGRADATION (intentional): the token is already minted by
          // Better Auth before this callback runs; a delivery failure must NOT
          // 500 the sign-in request. The production mailer already swallows +
          // logs its own send errors, but we defend here too so ANY unexpected
          // throw (future mailer, template error) degrades to "logged" rather
          // than a 500 that leaks that send failed. The user still sees the
          // generic "check your inbox" response. Remove once the Cloudflare
          // Email tier reliably delivers to arbitrary recipients.
          try {
            await mailer.sendMagicLink({ to: email, url });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(
              `[auth] sendMagicLink delivery failed (sign-in still succeeds): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        },
      }),
      // MUST be last (Better Auth docs).
      sveltekitCookies(getRequestEvent),
    ],
  });
}
