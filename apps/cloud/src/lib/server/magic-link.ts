/**
 * Mint a magic sign-in link WITHOUT emailing it — for the public-MCP `signup`
 * flow, which hands the URL back to the calling agent as `loginUrl` instead.
 *
 * Better Auth's magic-link plugin builds the token + verification row and then
 * calls the configured `sendMagicLink`. We spin up a per-call Better Auth
 * instance whose mailer simply CAPTURES the URL, then invoke the same
 * `signInMagicLink` endpoint — so the token is created/hashed exactly as a
 * normal magic link (single-use, ~15 min TTL) and we get the URL to return.
 *
 * The link lands on /dashboard after verification (callbackURL).
 *
 * Better Auth derives its base URL from the request Host when BETTER_AUTH_URL
 * is unset, and it validates the request origin, so we pass a clean synthetic
 * Headers with an explicit host + origin (BETTER_AUTH_URL in production, else
 * the inbound request origin). The MCP transport's own request headers don't
 * reliably carry a usable Host, which is why we build them ourselves.
 */
import type { CloudEnv } from "../../app.d";
import { createAuth, PRODUCTION_ORIGIN } from "./auth";
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
    // it from headers the MCP transport doesn't reliably provide).
    const auth = createAuth({ ...env, BETTER_AUTH_URL: base }, capturingMailer);
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
