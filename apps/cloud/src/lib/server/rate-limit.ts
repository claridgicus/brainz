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

/**
 * Anonymous public-vault MCP reads: max per IP per rolling hour. A public token
 * grants unauthenticated read access, so its /mcp reads are throttled per-IP
 * (generous — reads are cheap and legitimate share-link traffic is bursty).
 */
export const PUBLIC_READ_RATE_LIMIT = 120;

/** Magic-link requests: max per email address per rolling hour. */
export const MAGIC_LINK_EMAIL_LIMIT = 5;

/** Magic-link requests: max per client IP per rolling hour. */
export const MAGIC_LINK_IP_LIMIT = 20;

/** Start of the rolling rate-limit window ending at `now`. */
export function rateWindowStart(now: Date): Date {
  return new Date(now.getTime() - RATE_WINDOW_MS);
}

/**
 * The dev-only shared bucket for header-less requests. In production a missing
 * cf-connecting-ip must NEVER land here (see resolveRateLimitIp) — it is a
 * shared key everyone could exhaust to DoS every other header-less client.
 */
export const LOCAL_IP_BUCKET = "local";

/**
 * Expand an IPv6 address to its 8 hextets (lowercase, no zero-compression).
 * Handles `::` and a trailing dotted IPv4 part. Null when it isn't IPv6.
 */
export function expandIpv6(ip: string): string[] | null {
  if (!ip.includes(":")) return null;
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    addr = addr.slice(0, v4.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}

/**
 * The bucket key for a client IP. IPv4 is the address itself; IPv6 is its /64
 * (`2001:db8:1:2::/64`), because a single subscriber typically holds a whole
 * /64 and could otherwise rotate addresses into unlimited fresh buckets.
 */
export function rateLimitBucket(ip: string): string {
  const groups = expandIpv6(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip;
}

/**
 * Resolve the rate-limit bucket key from the cf-connecting-ip header, FAILING
 * CLOSED in production (audit LOW).
 *
 * Cloudflare sets cf-connecting-ip on every edge request, so in production its
 * absence means the request did not arrive through the edge as expected; we
 * must NOT pool such traffic into one shared "local" bucket — a single actor
 * could then send header-less requests to exhaust that shared cap and DoS every
 * other header-less client. So in production a missing header returns
 * `{ ok: false }` and the caller rejects the request. Only a genuine local/dev
 * build (isProduction=false) falls back to the shared LOCAL_IP_BUCKET, which is
 * the intended convenience for `wrangler dev` / tests where no edge header
 * exists. IPv6 addresses are bucketed by /64 (rateLimitBucket), which covers
 * every guard keyed on this value (signup, public reads, magic links,
 * password sign-in, DCR). Pure + exported for unit testing.
 */
export function resolveRateLimitIp(
  cfConnectingIp: string | null,
  isProduction: boolean,
): { ok: true; ip: string } | { ok: false } {
  if (cfConnectingIp) return { ok: true, ip: rateLimitBucket(cfConnectingIp) };
  if (isProduction) return { ok: false };
  return { ok: true, ip: LOCAL_IP_BUCKET };
}

/** Has `countInWindow` reached (or passed) `limit`? */
export function exceedsRateLimit(countInWindow: number, limit: number): boolean {
  return countInWindow >= limit;
}

/** Back-compat alias for the public-MCP signup limiter. */
export function exceedsSignupRateLimit(countInWindow: number): boolean {
  return exceedsRateLimit(countInWindow, SIGNUP_RATE_LIMIT);
}

/**
 * Over-limit test for the ATOMIC insert-then-count limiters (TOCTOU fix).
 *
 * `exceedsRateLimit` is 0-based: it takes a PRE-insert count and trips once it
 * has reached the cap (count >= limit), i.e. "there are already `limit` rows,
 * so this next one is one too many". The atomic limiters record the attempt
 * BEFORE counting, so their count is 1-based (INCLUDES this attempt): the Nth
 * attempt in the window sees N. That attempt is legitimate up to and including
 * the cap, so we reject only once the inclusive count has PASSED the limit
 * (count > limit). This keeps the effective allowance identical — a cap of 5
 * still admits exactly 5 attempts per window — while making the check atomic:
 * every concurrent request contributes its own row before any of them counts,
 * so at most `limit` of them can observe a count at or below the cap.
 */
export function exceedsRateLimitInclusive(countInclusive: number, limit: number): boolean {
  return countInclusive > limit;
}

/**
 * Inclusive-count signup limiter (TOCTOU-safe path). The signup flow records
 * the attempt BEFORE counting, so `countInclusive` includes this attempt; trips
 * once it has passed SIGNUP_RATE_LIMIT (count > limit), admitting exactly
 * SIGNUP_RATE_LIMIT signups per window. See exceedsRateLimitInclusive.
 */
export function exceedsSignupRateLimitInclusive(countInclusive: number): boolean {
  return exceedsRateLimitInclusive(countInclusive, SIGNUP_RATE_LIMIT);
}

/**
 * Inclusive-count public-read limiter (TOCTOU-safe path, mirrors signup). The
 * public MCP read path records the attempt BEFORE counting, so `countInclusive`
 * includes this attempt; trips once it has passed PUBLIC_READ_RATE_LIMIT.
 */
export function exceedsPublicReadRateLimitInclusive(countInclusive: number): boolean {
  return exceedsRateLimitInclusive(countInclusive, PUBLIC_READ_RATE_LIMIT);
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
 * Whether a magic-link REQUEST should be throttled, given the INCLUSIVE window
 * counts (i.e. counted AFTER recording this attempt — see the TOCTOU-safe
 * insert-then-count order in guardMagicLinkRequest). Either dimension trips it.
 * Uses the inclusive (count > limit) test so a cap of 5 still admits exactly 5
 * attempts per window.
 */
export function magicLinkThrottled(counts: {
  emailInWindow: number;
  ipInWindow: number;
}): boolean {
  return (
    exceedsRateLimitInclusive(counts.emailInWindow, MAGIC_LINK_EMAIL_LIMIT) ||
    exceedsRateLimitInclusive(counts.ipInWindow, MAGIC_LINK_IP_LIMIT)
  );
}
