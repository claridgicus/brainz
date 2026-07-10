import { describe, expect, it } from "vitest";
import {
  dedupeSlug,
  exceedsRateLimit,
  exceedsSignupRateLimit,
  MAGIC_LINK_EMAIL_LIMIT,
  MAGIC_LINK_IP_LIMIT,
  magicLinkThrottled,
  RATE_WINDOW_MS,
  rateWindowStart,
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
  it("exceedsRateLimit trips exactly at the limit", () => {
    expect(exceedsRateLimit(0, 5)).toBe(false);
    expect(exceedsRateLimit(4, 5)).toBe(false);
    expect(exceedsRateLimit(5, 5)).toBe(true);
    expect(exceedsRateLimit(9, 5)).toBe(true);
  });

  it("signup limit is 5/hour and trips at the boundary", () => {
    expect(SIGNUP_RATE_LIMIT).toBe(5);
    for (let n = 0; n < SIGNUP_RATE_LIMIT; n++) expect(exceedsSignupRateLimit(n)).toBe(false);
    expect(exceedsSignupRateLimit(SIGNUP_RATE_LIMIT)).toBe(true);
    expect(exceedsSignupRateLimit(SIGNUP_RATE_LIMIT + 3)).toBe(true);
  });
});

describe("magic-link limiter (per-email + per-IP)", () => {
  it("limits are 5/email/hour and 20/IP/hour", () => {
    expect(MAGIC_LINK_EMAIL_LIMIT).toBe(5);
    expect(MAGIC_LINK_IP_LIMIT).toBe(20);
  });

  it("does not throttle below both limits", () => {
    expect(magicLinkThrottled({ emailInWindow: 4, ipInWindow: 19 })).toBe(false);
    expect(magicLinkThrottled({ emailInWindow: 0, ipInWindow: 0 })).toBe(false);
  });

  it("throttles when the per-email count reaches its limit (email boundary)", () => {
    expect(magicLinkThrottled({ emailInWindow: 5, ipInWindow: 0 })).toBe(true);
    // 5 emails to the same address trips even though the IP is nowhere near 20.
    expect(magicLinkThrottled({ emailInWindow: 5, ipInWindow: 1 })).toBe(true);
  });

  it("throttles when the per-IP count reaches its limit (IP boundary)", () => {
    // A single IP mail-bombing 20 different addresses trips even though each
    // address is under its own 5/hour cap.
    expect(magicLinkThrottled({ emailInWindow: 1, ipInWindow: 20 })).toBe(true);
    expect(magicLinkThrottled({ emailInWindow: 0, ipInWindow: 21 })).toBe(true);
  });
});

describe("dedupeSlug", () => {
  it("appends a numeric suffix only when the base is taken", () => {
    expect(dedupeSlug("my-vault", new Set())).toBe("my-vault");
    expect(dedupeSlug("my-vault", new Set(["my-vault"]))).toBe("my-vault-2");
    expect(dedupeSlug("my-vault", new Set(["my-vault", "my-vault-2"]))).toBe("my-vault-3");
  });
});
