import { describe, expect, it } from "vitest";
import { bfsRelated } from "../src/graph.js";
import type { ConceptMeta, Edge } from "../src/types.js";

function meta(id: string): ConceptMeta {
  return { id, title: id.toUpperCase(), type: "concept", status: "active", tags: [], filePath: `/v/${id}.md` };
}

function lookup(ids: string[]): (id: string) => ConceptMeta | null {
  const map = new Map(ids.map((id) => [id, meta(id)]));
  return (id) => map.get(id) ?? null;
}

// a -depends_on-> b -depends_on-> c -references-> d
const CHAIN: Edge[] = [
  { from: "a", to: "b", relation: "depends_on" },
  { from: "b", to: "c", relation: "depends_on" },
  { from: "c", to: "d", relation: "references" },
];
const NODES = lookup(["a", "b", "c", "d"]);

describe("bfsRelated", () => {
  it("traverses to depth 1 by default, in both directions", () => {
    expect(bfsRelated(CHAIN, "b", {}, NODES).map((n) => n.concept.id)).toEqual(["a", "c"]);
    // reverse direction: d is only reachable via an edge pointing *to* it
    expect(bfsRelated(CHAIN, "d", {}, NODES).map((n) => n.concept.id)).toEqual(["c"]);
  });

  it("respects depth (clamped to 3) and reports distance and via path", () => {
    const d2 = bfsRelated(CHAIN, "a", { depth: 2 }, NODES);
    expect(d2.map((n) => [n.concept.id, n.distance])).toEqual([
      ["b", 1],
      ["c", 2],
    ]);
    expect(d2.find((n) => n.concept.id === "c")!.via).toEqual([
      { from: "a", to: "b", relation: "depends_on" },
      { from: "b", to: "c", relation: "depends_on" },
    ]);
    const d9 = bfsRelated(CHAIN, "a", { depth: 9 }, NODES); // clamped to 3
    expect(d9.map((n) => n.concept.id)).toEqual(["b", "c", "d"]);
    expect(d9.find((n) => n.concept.id === "d")!.distance).toBe(3);
  });

  it("filters by relation types and applies limit after pending-filtering", () => {
    const only = bfsRelated(CHAIN, "c", { depth: 3, relations: ["references"] }, NODES);
    expect(only.map((n) => n.concept.id)).toEqual(["d"]);
    expect(bfsRelated(CHAIN, "a", { depth: 3, limit: 2 }, NODES)).toHaveLength(2);
  });

  it("returns [] for unknown start ids and excludes pending targets", () => {
    const edges: Edge[] = [{ from: "a", to: "ghost", relation: "references" }];
    const nodes = lookup(["a"]);
    expect(bfsRelated(edges, "nope", {}, nodes)).toEqual([]);
    expect(bfsRelated(edges, "a", {}, nodes)).toEqual([]); // ghost has no meta
  });

  it("is deterministic: results ordered by distance then id, regardless of edge order", () => {
    const star: Edge[] = [
      { from: "hub", to: "z", relation: "references" },
      { from: "hub", to: "m", relation: "references" },
      { from: "a", to: "hub", relation: "references" },
    ];
    const nodes = lookup(["hub", "a", "m", "z"]);
    const forward = bfsRelated(star, "hub", {}, nodes).map((n) => n.concept.id);
    const reversed = bfsRelated([...star].reverse(), "hub", {}, nodes).map((n) => n.concept.id);
    expect(forward).toEqual(["a", "m", "z"]);
    expect(reversed).toEqual(forward);
  });
});
