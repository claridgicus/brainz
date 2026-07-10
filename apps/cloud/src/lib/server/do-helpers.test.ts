import { graphResponseSchema, toolConceptMetaSchema } from "@brainz/contracts";
import type { ConceptMeta, Edge } from "@brainz/engine";
import { describe, expect, it } from "vitest";
import {
  buildGraphPayload,
  compactMeta,
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
