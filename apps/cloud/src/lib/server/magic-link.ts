/**
 * Mint a magic sign-in link WITHOUT emailing it — used EXCLUSIVELY by the
 * /claim/[token] APPROVE action (Wave G) to sign the approving human's
 * browser in server-side: the action mints a verify URL and 303-redirects
 * THIS browser to it, landing on /dashboard. The URL never appears anywhere
 * else — not in tool results, not in logs, not in email.
 *
 * IT MUST NEVER BE CALLED FROM SIGNUP (or any agent-facing flow): the retired
 * `loginUrl` design handed a session-granting URL into agent context, where
 * orchestrator logs could launder a session without any inbox proof. Wave G
 * removed that path entirely — signup returns no URL of any kind.
 *
 * Better Auth's magic-link plugin builds the token + verification row and then
 * calls the configured `sendMagicLink`. We spin up a per-call Better Auth
 * instance whose mailer simply CAPTURES the URL, then invoke the same
 * `signInMagicLink` endpoint — so the token is created/hashed exactly as a
 * normal magic link (single-use: consumed atomically on first verify) and we
 * get the URL to redirect to. The instance is pinned to the very short
 * APPROVE_REDIRECT_TTL_SECONDS since the redirect consumes it immediately.
 *
 * The link lands on /dashboard after verification (callbackURL).
 *
 * Better Auth derives its base URL from the request Host when BETTER_AUTH_URL
 * is unset, and it validates the request origin, so we pass a clean synthetic
 * Headers with an explicit host + origin (BETTER_AUTH_URL in production, else
 * the inbound request origin).
 */
import type { CloudEnv } from "../../app.d";
import { APPROVE_REDIRECT_TTL_SECONDS, createAuth, PRODUCTION_ORIGIN } from "./auth";
import type { Mailer } from "./mailer";

/**
 * Returns a function that mints a magic sign-in link for an email and returns
 * its URL (never emails it). `requestOrigin` is the inbound request's origin
 * (e.g. event.url.origin) — used as the base URL fallback when BETTER_AUTH_URL
 * is unset (local dev).
 */
export function magicLinkMinter(
  env: CloudEnv,
  requestOrigin: string,
): (email: string) => Promise<string> {
  const base = env.BETTER_AUTH_URL || requestOrigin || PRODUCTION_ORIGIN;
  const host = new URL(base).host;
  return async (email: string) => {
    let captured: string | null = null;
    const capturingMailer: Mailer = {
      async sendMagicLink({ url }) {
        captured = url;
      },
    };
    // Pin the base URL so Better Auth can build the verify URL even in local
    // dev (where BETTER_AUTH_URL is unset and it would otherwise try to derive
    // it from headers). Pin the short approve-redirect TTL — the URL is
    // consumed by the immediate 303 that follows.
    const auth = createAuth({ ...env, BETTER_AUTH_URL: base }, capturingMailer, {
      magicLinkTtlSeconds: APPROVE_REDIRECT_TTL_SECONDS,
    });
    // Synthetic headers with a trusted host/origin so Better Auth can resolve
    // its base URL and pass the origin check.
    const headers = new Headers({ host, origin: base, "content-type": "application/json" });
    await auth.api.signInMagicLink({
      body: { email, callbackURL: "/dashboard" },
      headers,
    });
    if (!captured) {
      throw new Error("failed to mint magic sign-in link");
    }
    return captured;
  };
}
