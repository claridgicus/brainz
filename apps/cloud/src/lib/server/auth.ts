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
 *   mailer instead of the env-selected one. The signup flow passes a capturing
 *   mailer so it can return the link as `loginUrl` rather than emailing it.
 */
export function createAuth(env: CloudEnv, mailerOverride?: Mailer) {
  const db = createDb(env.DB);
  const mailer = mailerOverride ?? createMailer(env);
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
    socialProviders: github,
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        // Hash tokens at rest — the plaintext exists only inside the emailed URL.
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await mailer.sendMagicLink({ to: email, url });
        },
      }),
      // MUST be last (Better Auth docs).
      sveltekitCookies(getRequestEvent),
    ],
  });
}
