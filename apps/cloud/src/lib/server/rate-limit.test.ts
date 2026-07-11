import { describe, expect, it } from "vitest";
import {
  dedupeSlug,
  exceedsRateLimit,
  exceedsRateLimitInclusive,
  exceedsSignupRateLimit,
  exceedsSignupRateLimitInclusive,
  LOCAL_IP_BUCKET,
  MAGIC_LINK_EMAIL_LIMIT,
  MAGIC_LINK_IP_LIMIT,
  magicLinkThrottled,
  RATE_WINDOW_MS,
  rateWindowStart,
  resolveRateLimitIp,
  SIGNUP_RATE_LIMIT,
} from "./rate-limit";

describe("rolling window", () => {
  it("rateWindowStart is exactly one hour before now", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(now.getTime() - rateWindowStart(now).getTime()).toBe(RATE_WINDOW_MS);
    expect(RATE_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

describe("generic + signup limiter", () => {
  it("exceedsRateLimit (0-based, pre-insert) trips exactly at the limit", () => {
    expect(exceedsRateLimit(0, 5)).toBe(false);
    expect(exceedsRateLimit(4, 5)).toBe(false);
    expect(exceedsRateLimit(5, 5)).toBe(true);
    expect(exceedsRateLimit(9, 5)).toBe(true);
  });

  it("exceedsRateLimitInclusive (1-based, post-insert) trips one past the limit", () => {
    // Count INCLUDES this attempt: the Nth attempt sees N, and is legitimate up
    // to and including the cap. A cap of 5 admits attempts 1..5, rejects 6+.
    expect(exceedsRateLimitInclusive(1, 5)).toBe(false);
    expect(exceedsRateLimitInclusive(5, 5)).toBe(false);
    expect(exceedsRateLimitInclusive(6, 5)).toBe(true);
    expect(exceedsRateLimitInclusive(9, 5)).toBe(true);
  });

  it("signup limit is 5/hour (0-based helper trips at the boundary)", () => {
    expect(SIGNUP_RATE_LIMIT).toBe(5);
    for (let n = 0; n < SIGNUP_RATE_LIMIT; n++) expect(exceedsSignupRateLimit(n)).toBe(false);
    expect(exceedsSignupRateLimit(SIGNUP_RATE_LIMIT)).toBe(true);
    expect(exceedsSignupRateLimit(SIGNUP_RATE_LIMIT + 3)).toBe(true);
  });

  it("signup inclusive helper admits exactly 5, rejects the 6th (TOCTOU path)", () => {
    // Insert-then-count: the Nth signup in the window sees a count of N.
    for (let n = 1; n <= SIGNUP_RATE_LIMIT; n++) {
      expect(exceedsSignupRateLimitInclusive(n)).toBe(false);
    }
    expect(exceedsSignupRateLimitInclusive(SIGNUP_RATE_LIMIT + 1)).toBe(true);
    expect(exceedsSignupRateLimitInclusive(SIGNUP_RATE_LIMIT + 4)).toBe(true);
  });
});

describe("magic-link limiter (per-email + per-IP, inclusive counts)", () => {
  it("limits are 5/email/hour and 20/IP/hour", () => {
    expect(MAGIC_LINK_EMAIL_LIMIT).toBe(5);
    expect(MAGIC_LINK_IP_LIMIT).toBe(20);
  });

  it("does not throttle at or below both limits (counts include this attempt)", () => {
    // The 5th email attempt / 20th IP attempt sees counts of exactly 5 / 20 and
    // is still allowed — the cap admits exactly that many per window.
    expect(magicLinkThrottled({ emailInWindow: 5, ipInWindow: 20 })).toBe(false);
    expect(magicLinkThrottled({ emailInWindow: 4, ipInWindow: 19 })).toBe(false);
    expect(magicLinkThrottled({ emailInWindow: 1, ipInWindow: 1 })).toBe(false);
  });

  it("throttles once the per-email count passes its limit (6th to the address)", () => {
    expect(magicLinkThrottled({ emailInWindow: 6, ipInWindow: 1 })).toBe(true);
    // 6 requests to the same address trips even though the IP is nowhere near 20.
    expect(magicLinkThrottled({ emailInWindow: 6, ipInWindow: 2 })).toBe(true);
  });

  it("throttles once the per-IP count passes its limit (21st from the IP)", () => {
    // A single IP mail-bombing 21 different addresses trips even though each
    // address is under its own 5/hour cap.
    expect(magicLinkThrottled({ emailInWindow: 1, ipInWindow: 21 })).toBe(true);
    expect(magicLinkThrottled({ emailInWindow: 0, ipInWindow: 22 })).toBe(true);
  });
});

describe("resolveRateLimitIp (fail-closed on missing cf-connecting-ip)", () => {
  it("returns the IP when the header is present (prod or dev)", () => {
    expect(resolveRateLimitIp("203.0.113.7", true)).toEqual({ ok: true, ip: "203.0.113.7" });
    expect(resolveRateLimitIp("203.0.113.7", false)).toEqual({ ok: true, ip: "203.0.113.7" });
  });

  it("FAILS CLOSED in production when the header is missing (no shared bucket)", () => {
    expect(resolveRateLimitIp(null, true)).toEqual({ ok: false });
    // Never leaks the shared local bucket into a production decision.
    expect(resolveRateLimitIp(null, true)).not.toHaveProperty("ip");
  });

  it("falls back to the shared local bucket only in dev", () => {
    expect(resolveRateLimitIp(null, false)).toEqual({ ok: true, ip: LOCAL_IP_BUCKET });
    expect(LOCAL_IP_BUCKET).toBe("local");
  });
});

describe("dedupeSlug", () => {
  it("appends a numeric suffix only when the base is taken", () => {
    expect(dedupeSlug("my-vault", new Set())).toBe("my-vault");
    expect(dedupeSlug("my-vault", new Set(["my-vault"]))).toBe("my-vault-2");
    expect(dedupeSlug("my-vault", new Set(["my-vault", "my-vault-2"]))).toBe("my-vault-3");
  });
});
