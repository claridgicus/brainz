import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  isApiKeyFormat,
  keyPrefixOf,
  parseBearer,
} from "./api-keys";

describe("generateApiKey", () => {
  it("produces bz_ + 32 base62 chars", () => {
    for (let i = 0; i < 20; i++) {
      const key = generateApiKey();
      expect(key).toMatch(/^bz_[A-Za-z0-9]{32}$/);
      expect(isApiKeyFormat(key)).toBe(true);
    }
  });

  it("produces unique keys", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey()));
    expect(keys.size).toBe(100);
  });
});

describe("isApiKeyFormat", () => {
  it("rejects malformed tokens", () => {
    expect(isApiKeyFormat("")).toBe(false);
    expect(isApiKeyFormat("bz_short")).toBe(false);
    expect(isApiKeyFormat("sk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(isApiKeyFormat(`bz_${"a".repeat(31)}!`)).toBe(false);
    expect(isApiKeyFormat(`bz_${"a".repeat(33)}`)).toBe(false);
  });
});

describe("hashApiKey", () => {
  it("is SHA-256 hex of the plaintext", async () => {
    // sha256("abc") — well-known test vector.
    expect(await hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and 64 hex chars", async () => {
    const key = generateApiKey();
    const h1 = await hashApiKey(key);
    const h2 = await hashApiKey(key);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("keyPrefixOf", () => {
  it("keeps only the display prefix", () => {
    const key = `bz_ABCDE${"x".repeat(27)}`;
    expect(keyPrefixOf(key)).toBe("bz_ABCDE…");
    expect(keyPrefixOf(key).length).toBeLessThan(key.length);
  });
});

describe("parseBearer", () => {
  it("extracts bearer tokens", () => {
    expect(parseBearer("Bearer bz_abc")).toBe("bz_abc");
    expect(parseBearer("bearer tok")).toBe("tok");
    expect(parseBearer("  Bearer   spaced  ")).toBe("spaced");
  });

  it("returns null for missing/malformed headers", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
  });
});

describe("API_KEY_PREFIX", () => {
  it("is the documented bz_ prefix", () => {
    expect(API_KEY_PREFIX).toBe("bz_");
  });
});
