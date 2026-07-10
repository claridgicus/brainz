import { describe, expect, it } from "vitest";
import { assembleContext, type ContextSource } from "../src/context.js";
import type { Concept, Edge } from "../src/types.js";

function concept(id: string, body: string, extra: Partial<Concept> = {}): Concept {
  return {
    id,
    title: id.charAt(0).toUpperCase() + id.slice(1),
    type: "concept",
    status: "active",
    tags: [],
    filePath: `/v/${id}.md`,
    body,
    ...extra,
  };
}

function source(concepts: Concept[], edges: Edge[]): ContextSource {
  const map = new Map(concepts.map((c) => [c.id, c]));
  return {
    edges,
    getMeta: (id) => {
      const c = map.get(id);
      if (!c) return null;
      const { body: _body, ...meta } = c;
      return meta;
    },
    getConcept: (id) => map.get(id) ?? null,
  };
}

const GRAPH = source(
  [
    concept("a", "Alpha links [[b]]."),
    concept("b", "Beta body."),
    concept("c", "Gamma body."),
  ],
  [
    { from: "a", to: "b", relation: "references" },
    { from: "b", to: "c", relation: "depends_on" },
  ],
);

describe("assembleContext", () => {
  it("keeps seed order, expands to depth, and formats sections", () => {
    const bundle = assembleContext(["a"], GRAPH, { depth: 1 });
    expect(bundle.included.map((m) => m.id)).toEqual(["a", "b"]);
    expect(bundle.markdown).toContain("## A (a)");
    expect(bundle.markdown).toContain("## B (b)");
    expect(bundle.truncated).toBe(false);
    expect(bundle.approxTokens).toBe(Math.ceil(bundle.markdown.length / 4));
  });

  it("depth 0 includes seeds only; default depth is 1", () => {
    expect(assembleContext(["a"], GRAPH, { depth: 0 }).included.map((m) => m.id)).toEqual(["a"]);
    expect(assembleContext(["a"], GRAPH).included.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("dedups seeds and drops unknown seed ids", () => {
    const bundle = assembleContext(["b", "ghost", "b", "a"], GRAPH, { depth: 0 });
    expect(bundle.included.map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("expands deterministically (sorted ids per layer) and skips pending nodes", () => {
    const s = source(
      [concept("hub", "Hub."), concept("z", "Z."), concept("m", "M.")],
      [
        { from: "hub", to: "z", relation: "references" },
        { from: "hub", to: "m", relation: "references" },
        { from: "hub", to: "ghost", relation: "references" },
      ],
    );
    const bundle = assembleContext(["hub"], s, { depth: 1 });
    expect(bundle.included.map((c) => c.id)).toEqual(["hub", "m", "z"]);
  });

  it("stops before exceeding the token budget and sets truncated", () => {
    const big = "lorem ipsum dolor ".repeat(300); // ~5400 chars ≈ 1350 tokens
    const s = source(
      [concept("s1", `${big} [[s2]]`), concept("s2", big)],
      [{ from: "s1", to: "s2", relation: "references" }],
    );
    const all = assembleContext(["s1", "s2"], s);
    expect(all.truncated).toBe(false);
    expect(all.included).toHaveLength(2);

    const cut = assembleContext(["s1", "s2"], s, { tokenBudget: 1500 });
    expect(cut.truncated).toBe(true);
    expect(cut.included.map((m) => m.id)).toEqual(["s1"]);
    expect(cut.approxTokens).toBeLessThanOrEqual(1500);
  });

  it("filters expansion by product (seeds are exempt)", () => {
    const s = source(
      [
        concept("x", "Links [[y]] and [[z]].", { product: "p" }),
        concept("y", "Y.", { product: "p" }),
        concept("z", "Z.", { product: "other" }),
      ],
      [
        { from: "x", to: "y", relation: "references" },
        { from: "x", to: "z", relation: "references" },
      ],
    );
    const bundle = assembleContext(["x"], s, { product: "p" });
    expect(bundle.included.map((m) => m.id)).toEqual(["x", "y"]);
  });

  it("returns an empty bundle for no usable seeds", () => {
    const bundle = assembleContext(["ghost"], GRAPH);
    expect(bundle).toEqual({ markdown: "", included: [], truncated: false, approxTokens: 0 });
  });
});
