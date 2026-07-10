import { describe, expect, it } from "vitest";
import {
  CLAIM_TTL_MS,
  claimExpiry,
  claimState,
  dedupeSlug,
  exceedsSignupRateLimit,
  generateClaimToken,
  hashClaimToken,
  isClaimTokenFormat,
  rateWindowStart,
  SIGNUP_RATE_LIMIT,
  SIGNUP_RATE_WINDOW_MS,
} from "./claims";

describe("claim tokens", () => {
  it("generates 64-hex-char tokens, unique per call", () => {
    const a = generateClaimToken();
    const b = generateClaimToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(isClaimTokenFormat(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("rejects non-token shapes", () => {
    expect(isClaimTokenFormat("")).toBe(false);
    expect(isClaimTokenFormat("bz_abc")).toBe(false);
    expect(isClaimTokenFormat("Z".repeat(64))).toBe(false);
    expect(isClaimTokenFormat(generateClaimToken().slice(1))).toBe(false);
  });

  it("hashes deterministically to SHA-256 hex and never equals the plaintext", async () => {
    const token = generateClaimToken();
    const h1 = await hashClaimToken(token);
    const h2 = await hashClaimToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(token);
    expect(await hashClaimToken(generateClaimToken())).not.toBe(h1);
    // Known vector: SHA-256("abc")
    expect(await hashClaimToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("claim expiry / single use", () => {
  const created = new Date("2026-07-10T00:00:00.000Z");

  it("expiry is created_at + 7 days", () => {
    expect(claimExpiry(created).getTime() - created.getTime()).toBe(CLAIM_TTL_MS);
    expect(CLAIM_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("valid while unclaimed and before expiry", () => {
    const claim = { expiresAt: claimExpiry(created), claimedAt: null };
    expect(claimState(claim, new Date(created.getTime() + 1000))).toBe("valid");
    expect(claimState(claim, new Date(claim.expiresAt.getTime() - 1))).toBe("valid");
  });

  it("expired at and after expires_at", () => {
    const claim = { expiresAt: claimExpiry(created), claimedAt: null };
    expect(claimState(claim, claim.expiresAt)).toBe("expired");
    expect(claimState(claim, new Date(claim.expiresAt.getTime() + 1))).toBe("expired");
  });

  it("claimed wins over expiry (single-use)", () => {
    const claim = { expiresAt: claimExpiry(created), claimedAt: created };
    expect(claimState(claim, new Date(created.getTime() + 1000))).toBe("claimed");
    expect(claimState(claim, new Date(claim.expiresAt.getTime() + 1))).toBe("claimed");
  });
});

describe("signup rate limit (5 per IP per hour)", () => {
  it("window start is one hour before now", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(now.getTime() - rateWindowStart(now).getTime()).toBe(SIGNUP_RATE_WINDOW_MS);
    expect(SIGNUP_RATE_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it("allows up to 5 signups in the window, blocks the 6th", () => {
    expect(SIGNUP_RATE_LIMIT).toBe(5);
    for (let n = 0; n < SIGNUP_RATE_LIMIT; n++) expect(exceedsSignupRateLimit(n)).toBe(false);
    expect(exceedsSignupRateLimit(SIGNUP_RATE_LIMIT)).toBe(true);
    expect(exceedsSignupRateLimit(SIGNUP_RATE_LIMIT + 3)).toBe(true);
  });
});

describe("dedupeSlug", () => {
  it("returns the base when free, else suffixes -2, -3, …", () => {
    expect(dedupeSlug("my-vault", new Set())).toBe("my-vault");
    expect(dedupeSlug("my-vault", new Set(["my-vault"]))).toBe("my-vault-2");
    expect(dedupeSlug("my-vault", new Set(["my-vault", "my-vault-2"]))).toBe("my-vault-3");
  });
});
