/**
 * The system-wide email normalizer — the single choke-point every email passes
 * through before it is stored, compared, or used as a rate-limit key. These
 * tests pin the invariant: mixed-case + surrounding whitespace collapse to one
 * canonical form, so `James@X.com` and `james@x.com` can never fork.
 */
import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("lowercases", () => {
    expect(normalizeEmail("James@Example.COM")).toBe("james@example.com");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeEmail("  user@example.com  ")).toBe("user@example.com");
  });

  it("trims AND lowercases together", () => {
    expect(normalizeEmail("\t  MixedCase@Example.COM \n")).toBe("mixedcase@example.com");
  });

  it("is idempotent — a canonical email is unchanged", () => {
    const canonical = "already@lower.com";
    expect(normalizeEmail(canonical)).toBe(canonical);
    expect(normalizeEmail(normalizeEmail("A@B.com"))).toBe(normalizeEmail("A@B.com"));
  });

  it("collapses case variants to the SAME key (no fork, one bucket)", () => {
    const variants = [
      "James@X.com",
      "james@x.com",
      "JAMES@X.COM",
      "  James@X.com ",
      "jAmEs@x.COM",
    ];
    const normalized = new Set(variants.map(normalizeEmail));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe("james@x.com");
  });
});
