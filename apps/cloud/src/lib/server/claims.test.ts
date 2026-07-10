import { describe, expect, it } from "vitest";
import {
  CLAIM_TTL_MS,
  claimExpiry,
  claimState,
  consumeClaim,
  dedupeSlug,
  exceedsSignupRateLimit,
  generateClaimToken,
  hashClaimToken,
  isClaimTokenFormat,
  rateWindowStart,
  SIGNUP_RATE_LIMIT,
  SIGNUP_RATE_WINDOW_MS,
} from "./claims";

/**
 * In-memory stand-in for the D1 conditional consume UPDATE
 *   UPDATE account_claims SET claimed_at=? WHERE id=? AND claimed_at IS NULL RETURNING id
 * The DB serialises concurrent updates; we model that by mutating shared state
 * synchronously inside each call, so the second caller observes the first
 * caller's write. Returns the rows actually updated (0 or 1).
 */
function fakeConsumer(claims: Map<string, { claimedAt: Date | null }>) {
  let calls = 0;
  const consume = async (id: string, claimedAt: Date) => {
    calls++;
    const row = claims.get(id);
    if (!row || row.claimedAt !== null) return [];
    row.claimedAt = claimedAt; // WHERE claimed_at IS NULL matched → consume
    return [{ id }];
  };
  return { consume, calls: () => calls };
}

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

describe("consumeClaim (atomic single-use redemption)", () => {
  const at = new Date("2026-07-10T00:00:00.000Z");

  it("wins on an unclaimed row and marks claimed_at exactly once", async () => {
    const claims = new Map([["c1", { claimedAt: null as Date | null }]]);
    const { consume } = fakeConsumer(claims);
    expect(await consumeClaim(consume, "c1", at)).toBe(true);
    expect(claims.get("c1")!.claimedAt).toBe(at);
  });

  it("loses on an already-claimed row (0 rows affected → false)", async () => {
    const claims = new Map([["c1", { claimedAt: new Date("2026-01-01") as Date | null }]]);
    const { consume } = fakeConsumer(claims);
    const first = claims.get("c1")!.claimedAt;
    expect(await consumeClaim(consume, "c1", at)).toBe(false);
    // Does not clobber the existing claimed_at.
    expect(claims.get("c1")!.claimedAt).toBe(first);
  });

  it("double redemption of one token: exactly one wins, the second is 'already used'", async () => {
    const claims = new Map([["c1", { claimedAt: null as Date | null }]]);
    const { consume, calls } = fakeConsumer(claims);

    // Two concurrent submissions of the same valid token. Both would pass the
    // check-then-act pre-checks; only the conditional consume decides the winner.
    const results = await Promise.all([
      consumeClaim(consume, "c1", at),
      consumeClaim(consume, "c1", new Date(at.getTime() + 5)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1); // exactly one true
    expect(results.filter((r) => !r)).toHaveLength(1); // exactly one false → "already used"
    expect(calls()).toBe(2);
    // Winner's timestamp is the one persisted; the loser never overwrites it.
    expect(claims.get("c1")!.claimedAt).toBe(at);

    // A third, later attempt also loses — the claim stays consumed.
    expect(await consumeClaim(consume, "c1", new Date(at.getTime() + 10))).toBe(false);
    expect(claims.get("c1")!.claimedAt).toBe(at);
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
