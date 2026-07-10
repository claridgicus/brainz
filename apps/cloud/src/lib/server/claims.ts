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

/** Slug with a numeric suffix when the base is already taken: my-vault, my-vault-2, … */
export function dedupeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
