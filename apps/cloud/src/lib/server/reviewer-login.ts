/**
 * Gate in front of Better Auth's email+password sign-in (Wave OA). Password
 * sign-in exists only for operator-provisioned directory-reviewer accounts,
 * but enabling it exposes /api/auth/sign-in/email to everyone, and Better
 * Auth runs scrypt on every attempt (unknown emails included) behind an
 * in-memory, per-isolate limiter. So hooks.server.ts runs this first:
 *
 * 1. FAILED-attempt limits on the durable `magic_link_events` table, in their
 *    own `password:` buckets (so they never touch magic-link quota): 5 failures
 *    per email and 20 per IP bucket per hour → 429 before any hashing. Only
 *    failures are recorded (recordPasswordFailure, called by the hook when
 *    Better Auth rejects, and here for non-reviewer emails), so a reviewer who
 *    signs in successfully never burns their own allowance, and an attacker
 *    would need the reviewer's unguessable address to lock it out.
 * 2. the allow-list: an email without a `credential` account row gets Better
 *    Auth's own generic 401 without Better Auth (and scrypt) ever running.
 */
import { normalizeEmail } from "./email";
import { throttleResponse, type GuardDeps } from "./magic-link-guard";
import type { OAuthDb } from "./oauth";
import { MAGIC_LINK_EMAIL_LIMIT, MAGIC_LINK_IP_LIMIT, rateWindowStart } from "./rate-limit";

export const PASSWORD_SIGN_IN_PATH = "/api/auth/sign-in/email";

/** Namespaces password-failure rows in magic_link_events (separate buckets). */
export const PASSWORD_BUCKET_PREFIX = "password:";

const bucket = (args: { email: string; ip: string }) => ({
  email: `${PASSWORD_BUCKET_PREFIX}${normalizeEmail(args.email)}`,
  ip: `${PASSWORD_BUCKET_PREFIX}${args.ip}`,
});

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

/** Record one FAILED password attempt (never a success). */
export async function recordPasswordFailure(guard: GuardDeps, args: { email: string; ip: string }): Promise<void> {
  const b = bucket(args);
  await guard.record({ email: b.email, ip: b.ip, at: guard.now() });
}

/** Has this email or IP bucket already used up its failure allowance? */
async function failuresExhausted(guard: GuardDeps, args: { email: string; ip: string }): Promise<boolean> {
  const b = bucket(args);
  const since = rateWindowStart(guard.now());
  const [byEmail, byIp] = await Promise.all([
    guard.countRecentByEmail(b.email, since),
    guard.countRecentByIp(b.ip, since),
  ]);
  return byEmail >= MAGIC_LINK_EMAIL_LIMIT || byIp >= MAGIC_LINK_IP_LIMIT;
}

/** Null = let Better Auth handle the attempt; otherwise the response to send instead. */
export async function gatePasswordSignIn(
  deps: { db: OAuthDb; guard: GuardDeps },
  args: { email: string; ip: string },
): Promise<Response | null> {
  if (await failuresExhausted(deps.guard, args)) return throttleResponse();
  if (!(await hasCredentialAccount(deps.db, args.email))) {
    await recordPasswordFailure(deps.guard, args);
    return invalidCredentialsResponse();
  }
  return null;
}
