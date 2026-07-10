import { describe, expect, it } from "vitest";
import type { GraphPayload } from "@brainz/contracts";
import { filterGraph, neighborhood, radiusFor } from "./graph-data";

const edges = [
  { from: "a", to: "b", relation: "references" },
  { from: "b", to: "c", relation: "depends_on" },
  { from: "c", to: "d", relation: "references" },
];

const graph: GraphPayload = {
  nodes: [
    { id: "a", title: "A", type: "concept", tags: [], degree: 1 },
    { id: "b", title: "B", type: "feature", tags: [], degree: 2 },
    { id: "c", title: "C", type: "decision", tags: [], degree: 2 },
    { id: "d", title: "D", type: "pending", tags: [], degree: 1, pending: true },
  ],
  edges,
};

describe("neighborhood", () => {
  it("walks undirected hops from the root", () => {
    expect([...neighborhood(edges, "a", 1)].sort()).toEqual(["a", "b"]);
    expect([...neighborhood(edges, "a", 2)].sort()).toEqual(["a", "b", "c"]);
    expect([...neighborhood(edges, "d", 1)].sort()).toEqual(["c", "d"]);
  });
});

describe("filterGraph", () => {
  it("drops nodes of disabled types and their edges", () => {
    const out = filterGraph(graph, { types: new Set(["concept", "feature"]) });
    expect(out.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(out.edges).toEqual([edges[0]]);
  });

  it("focus keeps only the given set", () => {
    const out = filterGraph(graph, { focus: neighborhood(edges, "b", 1) });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(out.edges).toHaveLength(2);
  });
});

describe("radiusFor", () => {
  it("grows with degree", () => {
    expect(radiusFor(0)).toBe(6);
    expect(radiusFor(4)).toBeGreaterThan(radiusFor(1));
  });
});
