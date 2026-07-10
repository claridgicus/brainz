/**
 * assembleContext edge cases beyond context.test.ts: depth clamping, exact
 * budget boundaries, the Code areas line's interaction with truncation, and
 * product filtering of nodes without a product.
 */
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

describe("assembleContext edge cases", () => {
  it("clamps a negative depth to 0 (seeds only)", () => {
    const s = source(
      [concept("a", "Alpha."), concept("b", "Beta.")],
      [{ from: "a", to: "b", relation: "references" }],
    );
    const bundle = assembleContext(["a"], s, { depth: -3 });
    expect(bundle.included.map((m) => m.id)).toEqual(["a"]);
  });

  it("a section landing exactly on the budget is included, one char over is cut", () => {
    const body = "x".repeat(100);
    const s = source([concept("solo", body)], []);
    const sectionLength = `## Solo (solo)\n\n${body}`.length;
    const exactBudget = Math.ceil(sectionLength / 4);

    const fits = assembleContext(["solo"], s, { depth: 0, tokenBudget: exactBudget });
    expect(fits.truncated).toBe(false);
    expect(fits.included.map((m) => m.id)).toEqual(["solo"]);
    expect(fits.approxTokens).toBe(exactBudget);

    const cut = assembleContext(["solo"], s, { depth: 0, tokenBudget: exactBudget - 1 });
    expect(cut.truncated).toBe(true);
    expect(cut.included).toEqual([]);
    expect(cut.markdown).toBe("");
  });

  it("the Code areas line counts toward the budget and can push a section over it", () => {
    const body = "y".repeat(80);
    const areas = ["packages/core/src/vault.ts", "apps/cloud/src/routes/api/**"];
    const bare = `## Anchored (anchored)\n\n${body}`;
    const withAreas = `${bare}\n\nCode areas: ${areas.map((a) => `\`${a}\``).join(", ")}`;
    // A budget that fits the bare section but not the annotated one.
    const budget = Math.ceil(bare.length / 4) + 1;
    expect(Math.ceil(withAreas.length / 4)).toBeGreaterThan(budget);

    const plain = assembleContext(["anchored"], source([concept("anchored", body)], []), {
      depth: 0,
      tokenBudget: budget,
    });
    expect(plain.truncated).toBe(false);

    const annotated = assembleContext(
      ["anchored"],
      source([concept("anchored", body, { codeAreas: areas })], []),
      { depth: 0, tokenBudget: budget },
    );
    expect(annotated.truncated).toBe(true);
    expect(annotated.included).toEqual([]);
  });

  it("truncation cuts at the first over-budget section but keeps everything before it", () => {
    const s = source(
      [concept("s1", "short one"), concept("s2", "z".repeat(4000)), concept("s3", "short three")],
      [],
    );
    const bundle = assembleContext(["s1", "s2", "s3"], s, { depth: 0, tokenBudget: 100 });
    expect(bundle.truncated).toBe(true);
    // s2 blows the budget; the loop stops there (s3 is never considered).
    expect(bundle.included.map((m) => m.id)).toEqual(["s1"]);
  });

  it("product filter excludes expanded concepts with NO product (undefined !== product)", () => {
    const s = source(
      [
        concept("x", "Links [[np]].", { product: "p" }),
        concept("np", "No product here."),
      ],
      [{ from: "x", to: "np", relation: "references" }],
    );
    const bundle = assembleContext(["x"], s, { product: "p" });
    expect(bundle.included.map((m) => m.id)).toEqual(["x"]);
  });

  it("expansion continues past a pending node's layer without including it, and dedups multi-edges", () => {
    const s = source(
      [concept("hub", "Hub."), concept("far", "Far.")],
      [
        { from: "hub", to: "ghost", relation: "references" },
        { from: "ghost", to: "far", relation: "references" },
        // Duplicate edge — must not double-include far.
        { from: "ghost", to: "far", relation: "related_to" },
      ],
    );
    const bundle = assembleContext(["hub"], s, { depth: 2 });
    expect(bundle.included.map((m) => m.id)).toEqual(["hub", "far"]);
  });
});
