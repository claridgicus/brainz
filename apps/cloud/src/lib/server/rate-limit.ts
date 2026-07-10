/**
 * D1-backed rate limiting (pure, Workers-safe — no runtime deps).
 *
 * Better Auth's built-in limiter is in-memory, so it resets on every
 * per-request Worker instance and cannot survive across the fleet. These
 * helpers back a rolling-window counter with a D1 table (one row per event,
 * keyed by IP or email), which is durable and shared. Used by:
 *   - public-MCP `signup` (per-IP, 5/hour) — the `signup_events` table
 *   - the magic-link REQUEST path (per-email 5/hour, per-IP 20/hour) —
 *     the `magic_link_events` table
 *
 * The logic here is data-in / data-out so it is unit-testable without a
 * Workers/D1 runtime; the route/flow wires the actual COUNT query.
 */

/** One rolling hour, in ms. */
export const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Public-MCP signups: max per IP per rolling hour. */
export const SIGNUP_RATE_LIMIT = 5;

/** Magic-link requests: max per email address per rolling hour. */
export const MAGIC_LINK_EMAIL_LIMIT = 5;

/** Magic-link requests: max per client IP per rolling hour. */
export const MAGIC_LINK_IP_LIMIT = 20;

/** Start of the rolling rate-limit window ending at `now`. */
export function rateWindowStart(now: Date): Date {
  return new Date(now.getTime() - RATE_WINDOW_MS);
}

/** Has `countInWindow` reached (or passed) `limit`? */
export function exceedsRateLimit(countInWindow: number, limit: number): boolean {
  return countInWindow >= limit;
}

/** Back-compat alias for the public-MCP signup limiter. */
export function exceedsSignupRateLimit(countInWindow: number): boolean {
  return exceedsRateLimit(countInWindow, SIGNUP_RATE_LIMIT);
}

/** Slug with a numeric suffix when the base is already taken: my-vault, my-vault-2, … */
export function dedupeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Whether a magic-link REQUEST should be throttled, given the counts already
 * recorded for this email + IP inside the window. Either dimension trips it.
 */
export function magicLinkThrottled(counts: {
  emailInWindow: number;
  ipInWindow: number;
}): boolean {
  return (
    exceedsRateLimit(counts.emailInWindow, MAGIC_LINK_EMAIL_LIMIT) ||
    exceedsRateLimit(counts.ipInWindow, MAGIC_LINK_IP_LIMIT)
  );
}
