import type { ConceptMeta, Edge } from "@brainz/core";
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/graph.js";
import { filterGraph, neighborhood } from "../frontend/graph-data.js";

const meta = (id: string, type: ConceptMeta["type"] = "concept"): ConceptMeta => ({
  id,
  title: id.toUpperCase(),
  type,
  status: "active",
  tags: ["t"],
  filePath: `/vault/concepts/${id}.md`,
});

const edge = (from: string, to: string, relation = "references"): Edge => ({ from, to, relation });

describe("buildGraph (server)", () => {
  it("computes degree and synthesizes pending nodes", () => {
    const concepts = [meta("a"), meta("b", "feature")];
    const edges = [edge("a", "b"), edge("a", "ghost", "depends_on"), edge("b", "ghost")];
    const { nodes, edges: outEdges } = buildGraph(concepts, edges);

    expect(outEdges).toEqual(edges);
    expect(nodes).toHaveLength(3);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("a")?.degree).toBe(2);
    expect(byId.get("b")?.degree).toBe(2);

    const ghost = byId.get("ghost");
    expect(ghost).toMatchObject({ id: "ghost", title: "ghost", type: "pending", pending: true, degree: 2 });
  });

  it("counts self-loops once and handles zero-degree nodes", () => {
    const { nodes } = buildGraph([meta("solo"), meta("loop")], [edge("loop", "loop")]);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("solo")?.degree).toBe(0);
    expect(byId.get("loop")?.degree).toBe(1);
  });
});

describe("neighborhood (frontend)", () => {
  const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("x", "a")];

  it("is undirected and depth-bounded", () => {
    expect(neighborhood(edges, "a", 1)).toEqual(new Set(["a", "b", "x"]));
    expect(neighborhood(edges, "a", 2)).toEqual(new Set(["a", "b", "x", "c"]));
    expect(neighborhood(edges, "a", 0)).toEqual(new Set(["a"]));
  });
});

describe("filterGraph (frontend)", () => {
  const graph = {
    nodes: [
      { id: "a", title: "A", type: "concept", tags: [], degree: 1 },
      { id: "b", title: "B", type: "feature", tags: [], degree: 2 },
      { id: "c", title: "C", type: "pending", tags: [], degree: 1, pending: true },
    ],
    edges: [edge("a", "b"), edge("b", "c")],
  };

  it("drops nodes of disabled types and their edges", () => {
    const out = filterGraph(graph, { types: new Set(["concept", "feature"]) });
    expect(out.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(out.edges).toEqual([edge("a", "b")]);
  });

  it("applies focus sets", () => {
    const out = filterGraph(graph, { focus: new Set(["b", "c"]) });
    expect(out.nodes.map((n) => n.id)).toEqual(["b", "c"]);
    expect(out.edges).toEqual([edge("b", "c")]);
  });
});
