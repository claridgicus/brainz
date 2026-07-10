/**
 * Claim tokens + signup rate limiting (pure, Workers-safe — Web Crypto only).
 *
 * Claim tokens gate the /claim/[token] account-handoff page: the public MCP
 * `signup` tool mints one per provisioned account. 32 random bytes, hex on the
 * wire (URL-safe), SHA-256 hex at rest — the plaintext exists only inside the
 * claimUrl returned by the tool. Comparison is always hash-vs-hash; the
 * plaintext is never stored or logged.
 */

const TOKEN_BYTES = 32;

/** Claim links live for 7 days. */
export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Max public-MCP signups per IP per rolling hour. */
export const SIGNUP_RATE_LIMIT = 5;
export const SIGNUP_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Generate a plaintext claim token: 64 hex chars (32 random bytes). */
export function generateClaimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Does this look like one of our claim tokens? (cheap pre-filter, not auth) */
export function isClaimTokenFormat(token: string): boolean {
  return /^[0-9a-f]{64}$/.test(token);
}

/** SHA-256 hex digest of the plaintext token (what we store / look up). */
export async function hashClaimToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Expiry timestamp for a claim created at `createdAt`. */
export function claimExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + CLAIM_TTL_MS);
}

export type ClaimState = "valid" | "expired" | "claimed";

/** Redeemability of a claim row: single-use and time-boxed. */
export function claimState(
  claim: { expiresAt: Date; claimedAt: Date | null },
  now: Date,
): ClaimState {
  if (claim.claimedAt) return "claimed";
  if (now.getTime() >= claim.expiresAt.getTime()) return "expired";
  return "valid";
}

/** Start of the rolling rate-limit window ending at `now`. */
export function rateWindowStart(now: Date): Date {
  return new Date(now.getTime() - SIGNUP_RATE_WINDOW_MS);
}

/** Is a signup from this IP over the limit, given its count inside the window? */
export function exceedsSignupRateLimit(countInWindow: number): boolean {
  return countInWindow >= SIGNUP_RATE_LIMIT;
}

/**
 * Minimal shape of the conditional claim-consume UPDATE, so the win/lose logic
 * is testable without a Workers/D1 runtime. Implementations run:
 *   UPDATE account_claims SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL
 * and return the rows that were actually updated. The DB serialises concurrent
 * updates, so at most one caller ever sees a non-empty result.
 */
export type ClaimConsumer = (id: string, claimedAt: Date) => Promise<{ id: string }[]>;

/**
 * Atomically redeem a claim. The conditional UPDATE behind `consume` only
 * matches while claimed_at IS NULL, so exactly one of any number of concurrent
 * redemptions wins (returns true); everyone else sees 0 rows affected — the
 * claim was already consumed — and gets false. This is the single-use
 * guarantee. The pre-checks in the caller are only early, friendly exits; this
 * is the check that actually matters under concurrency.
 */
export async function consumeClaim(
  consume: ClaimConsumer,
  id: string,
  claimedAt: Date,
): Promise<boolean> {
  const updated = await consume(id, claimedAt);
  return updated.length > 0;
}

/** Slug with a numeric suffix when the base is already taken: my-vault, my-vault-2, … */
export function dedupeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
