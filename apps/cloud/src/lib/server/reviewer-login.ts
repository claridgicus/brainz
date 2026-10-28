/**
 * Gate in front of Better Auth's email+password sign-in (Wave OA). Password
 * sign-in exists only for operator-provisioned directory-reviewer accounts,
 * but enabling it exposes /api/auth/sign-in/email to everyone, and Better
 * Auth runs scrypt on every attempt (unknown emails included) behind an
 * in-memory, per-isolate limiter. So hooks.server.ts runs this first:
 *
 * 1. the durable D1 guard magic links use (5/hour/email, 20/hour/IP,
 *    record-then-count, `magic_link_events`), in its OWN buckets: keys carry
 *    PASSWORD_BUCKET_PREFIX, so password attempts never eat an address's or
 *    IP's magic-link quota (or the reverse). Throttled → 429 before hashing;
 * 2. the allow-list: an email without a `credential` account row gets Better
 *    Auth's own generic 401 without Better Auth (and scrypt) ever running.
 */
import { normalizeEmail } from "./email";
import { guardMagicLinkRequest, throttleResponse, type GuardDeps } from "./magic-link-guard";
import type { OAuthDb } from "./oauth";

export const PASSWORD_SIGN_IN_PATH = "/api/auth/sign-in/email";

/** Namespaces password-attempt rows in magic_link_events (separate buckets). */
export const PASSWORD_BUCKET_PREFIX = "password:";

/** Does this email belong to an operator-provisioned (credential) account? */
export async function hasCredentialAccount(db: OAuthDb, email: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM account a JOIN user u ON u.id = a.user_id
       WHERE u.email = ? AND a.provider_id = 'credential' AND a.password IS NOT NULL LIMIT 1`,
    )
    .bind(normalizeEmail(email))
    .first<{ ok: number }>();
  return row !== null;
}

/** The same body Better Auth sends for a wrong email/password pair (no existence oracle). */
export function invalidCredentialsResponse(): Response {
  return new Response(
    JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

/** Null = let Better Auth handle the attempt; otherwise the response to send instead. */
export async function gatePasswordSignIn(
  deps: { db: OAuthDb; guard: GuardDeps },
  args: { email: string; ip: string },
): Promise<Response | null> {
  const { throttled } = await guardMagicLinkRequest(deps.guard, {
    email: `${PASSWORD_BUCKET_PREFIX}${args.email}`,
    ip: `${PASSWORD_BUCKET_PREFIX}${args.ip}`,
  });
  if (throttled) return throttleResponse();
  if (!(await hasCredentialAccount(deps.db, args.email))) return invalidCredentialsResponse();
  return null;
}
