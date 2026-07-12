/**
 * Pure helpers of the public-vault domain (public vaults). The DB-backed
 * enable/rotate/disable/resolve + per-IP rate limit are exercised end-to-end
 * against real D1 in scripts/e2e.mjs (the §public-access journey); here we pin
 * the token discipline, the status derivation, and the URL builder.
 */
import { describe, expect, it } from "vitest";
import {
  hashPublicToken,
  mintPublicToken,
  publicStatusOf,
  publicUrl,
} from "./public-vault";
import type { schema } from "./db";

type VaultRow = typeof schema.vault.$inferSelect;

function vaultRow(over: Partial<VaultRow> = {}): VaultRow {
  return {
    id: "vault-1",
    ownerId: "owner-1",
    slug: "acme",
    name: "Acme",
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    onboardedAt: null,
    publicEnabled: false,
    publicTokenHash: null,
    publicCreatedAt: null,
    ...over,
  };
}

describe("mintPublicToken", () => {
  it("mints 64 hex chars (32 random bytes), unguessable and unique", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const t = mintPublicToken();
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      tokens.add(t);
    }
    expect(tokens.size).toBe(50);
  });
});

describe("hashPublicToken", () => {
  it("is SHA-256 hex — deterministic, and NOT the plaintext (stored hashed)", async () => {
    const token = mintPublicToken();
    const h1 = await hashPublicToken(token);
    const h2 = await hashPublicToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(token);
    // sha256("abc") test vector — same digest impl as api-keys/claim.
    expect(await hashPublicToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("publicStatusOf", () => {
  it("is disabled with no token", () => {
    expect(publicStatusOf(vaultRow())).toEqual({ enabled: false, createdAt: null });
  });

  it("is enabled only when the flag AND a hash are both present", () => {
    const created = new Date("2026-07-11T09:00:00.000Z");
    expect(
      publicStatusOf(
        vaultRow({ publicEnabled: true, publicTokenHash: "h", publicCreatedAt: created }),
      ),
    ).toEqual({ enabled: true, createdAt: created.toISOString() });

    // Flag on but hash cleared (a half-state) reads as disabled — never leaks.
    expect(
      publicStatusOf(vaultRow({ publicEnabled: true, publicTokenHash: null })),
    ).toEqual({ enabled: false, createdAt: null });
  });
});

describe("publicUrl", () => {
  it("builds the /public/<token> share link on the given origin", () => {
    expect(publicUrl("https://brainz.brownmatter.ai", "abc123")).toBe(
      "https://brainz.brownmatter.ai/public/abc123",
    );
  });
});
