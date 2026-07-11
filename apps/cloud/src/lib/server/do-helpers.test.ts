import { graphResponseSchema, toolConceptMetaSchema } from "@brainz/contracts";
import type { ConceptMeta, Edge } from "@brainz/engine";
import { describe, expect, it } from "vitest";
import {
  buildGraphPayload,
  compactMeta,
  isClaimStale,
  isEmbedRateLimited,
  keywordScore,
  makeSnippet,
  matchSnippet,
  syntheticFilePath,
  tokenize,
} from "./do-helpers";

function meta(id: string, overrides: Partial<ConceptMeta> = {}): ConceptMeta {
  return {
    id,
    title: id.toUpperCase(),
    type: "concept",
    status: "active",
    tags: [],
    filePath: syntheticFilePath(id),
    ...overrides,
  };
}

describe("compactMeta", () => {
  it("strips filePath/timestamps and parses with the contract schema", () => {
    const compact = compactMeta(
      meta("auth", { product: "crm", tags: ["a"], createdAt: "2026-01-01", updatedAt: "2026-01-02" }),
    );
    expect(toolConceptMetaSchema.strict().safeParse(compact).success).toBe(true);
    expect(compact).not.toHaveProperty("filePath");
    expect(compact).not.toHaveProperty("createdAt");
    expect(compact.product).toBe("crm");
  });

  it("omits product when undefined (strict schema, no undefined keys)", () => {
    const compact = compactMeta(meta("x"));
    expect("product" in compact).toBe(false);
  });
});

describe("tokenize", () => {
  it("splits on non-word chars, lowercases, caps at 32 terms", () => {
    expect(tokenize("Lead-Scoring: rules!")).toEqual(["lead", "scoring", "rules"]);
    expect(tokenize("")).toEqual([]);
    expect(tokenize(Array.from({ length: 50 }, (_, i) => `t${i}`).join(" "))).toHaveLength(32);
  });
});

describe("keywordScore", () => {
  const doc = { id: "lead-scoring", title: "Lead scoring", body: "Scores leads by fit.", tags: ["scoring"] };

  it("weights title > tags > body and returns 0 on no match", () => {
    expect(keywordScore(tokenize("scoring"), doc)).toBeGreaterThan(0);
    expect(keywordScore(tokenize("zebra"), doc)).toBe(0);
    const titleHit = keywordScore(["scoring"], { ...doc, tags: [], body: "" });
    const bodyHit = keywordScore(["scores"], { ...doc, title: "x", tags: [] });
    expect(titleHit).toBeGreaterThan(bodyHit);
  });

  it("ranks the better-matching doc higher", () => {
    const other = { id: "auth", title: "Auth", body: "Sessions and tokens.", tags: [] };
    const terms = tokenize("lead scoring");
    expect(keywordScore(terms, doc)).toBeGreaterThan(keywordScore(terms, other));
  });
});

describe("snippets", () => {
  it("makeSnippet flattens whitespace and truncates with an ellipsis", () => {
    expect(makeSnippet("a\n\nb   c")).toBe("a b c");
    const long = "word ".repeat(100);
    const snip = makeSnippet(long);
    expect(snip.length).toBeLessThanOrEqual(201);
    expect(snip.endsWith("…")).toBe(true);
  });

  it("matchSnippet centers on the first matching term", () => {
    const body = `${"x ".repeat(300)}needle in the middle ${"y ".repeat(300)}`;
    const snip = matchSnippet(body, ["needle"]);
    expect(snip).toContain("needle");
    expect(snip.length).toBeLessThanOrEqual(210);
  });
});

describe("buildGraphPayload", () => {
  const edges: Edge[] = [
    { from: "a", to: "b", relation: "references" },
    { from: "a", to: "ghost", relation: "depends_on" },
    { from: "b", to: "b", relation: "references" }, // self-loop counts once
  ];

  it("emits concept nodes + pending nodes and parses with the contract schema", () => {
    const payload = buildGraphPayload([meta("a", { product: "crm" }), meta("b")], edges);
    expect(graphResponseSchema.safeParse(payload).success).toBe(true);

    const ghost = payload.nodes.find((n) => n.id === "ghost");
    expect(ghost).toMatchObject({ type: "pending", pending: true, title: "ghost", degree: 1 });

    const a = payload.nodes.find((n) => n.id === "a");
    expect(a?.degree).toBe(2);
    expect(a?.pending).toBeUndefined();

    const b = payload.nodes.find((n) => n.id === "b");
    expect(b?.degree).toBe(2); // a→b + self-loop (once)
  });

  it("returns empty payload for an empty vault", () => {
    const payload = buildGraphPayload([], []);
    expect(payload).toEqual({ nodes: [], edges: [] });
    expect(graphResponseSchema.safeParse(payload).success).toBe(true);
  });
});

describe("isEmbedRateLimited", () => {
  const HOUR = 60 * 60 * 1000;
  const CAP = 1000;
  const now = 10 * HOUR;

  it("is false below the cap and true once the window reaches it", () => {
    const under = Array.from({ length: CAP - 1 }, () => now - 1);
    expect(isEmbedRateLimited(under, now, HOUR, CAP)).toBe(false);
    const at = Array.from({ length: CAP }, () => now - 1);
    expect(isEmbedRateLimited(at, now, HOUR, CAP)).toBe(true);
    const over = Array.from({ length: CAP + 5 }, () => now - 1);
    expect(isEmbedRateLimited(over, now, HOUR, CAP)).toBe(true);
  });

  it("only counts calls inside the rolling window (recovers as they age out)", () => {
    // CAP calls all just outside the window → not rate-limited (they aged out).
    const aged = Array.from({ length: CAP + 10 }, () => now - HOUR - 1);
    expect(isEmbedRateLimited(aged, now, HOUR, CAP)).toBe(false);
    // A boundary call exactly windowMs ago is outside (strict `>` cutoff).
    expect(isEmbedRateLimited([now - HOUR], now, HOUR, 1)).toBe(false);
    // One call inside the window with cap 1 → limited.
    expect(isEmbedRateLimited([now - 1], now, HOUR, 1)).toBe(true);
  });

  it("is never limited with no prior calls", () => {
    expect(isEmbedRateLimited([], now, HOUR, CAP)).toBe(false);
  });
});

describe("isClaimStale", () => {
  const TTL = 30 * 60 * 1000;
  const now = Date.parse("2026-07-11T12:00:00.000Z");

  it("is false for a fresh claim and true past the TTL", () => {
    const fresh = new Date(now - 60_000).toISOString(); // 1 min ago
    expect(isClaimStale(fresh, now, TTL)).toBe(false);
    const stale = new Date(now - TTL - 1).toISOString(); // just past TTL
    expect(isClaimStale(stale, now, TTL)).toBe(true);
    // Exactly at the TTL boundary counts as stale (>=).
    expect(isClaimStale(new Date(now - TTL).toISOString(), now, TTL)).toBe(true);
  });

  it("fails closed on missing/unparseable takenAt (never reclaims)", () => {
    expect(isClaimStale(null, now, TTL)).toBe(false);
    expect(isClaimStale(undefined, now, TTL)).toBe(false);
    expect(isClaimStale("not-a-date", now, TTL)).toBe(false);
    expect(isClaimStale("", now, TTL)).toBe(false);
  });
});
