import { describe, expect, it } from "vitest";
import type { ConceptTypeEntry, GraphPayload } from "@brainz/contracts";
import { PENDING_TYPE_COLOR } from "@brainz/contracts";
import {
  ALL_TYPES,
  colorForType,
  filterGraph,
  neighborhood,
  radiusFor,
  TYPE_COLORS,
  typeColorsFromRegistry,
} from "./graph-data";

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

describe("type registry colors", () => {
  it("built-in TYPE_COLORS matches the seed colors (defaults reproduce today)", () => {
    expect(TYPE_COLORS.domain).toBe("#60a5fa");
    expect(TYPE_COLORS.concept).toBe("#a78bfa");
    expect(TYPE_COLORS.pending).toBe(PENDING_TYPE_COLOR);
    // ALL_TYPES still includes pending (unchanged palette key order).
    expect(ALL_TYPES).toContain("concept");
    expect(ALL_TYPES).toContain("pending");
  });

  it("typeColorsFromRegistry falls back to built-ins when empty", () => {
    expect(typeColorsFromRegistry([])).toBe(TYPE_COLORS);
    expect(typeColorsFromRegistry(null)).toBe(TYPE_COLORS);
  });

  it("typeColorsFromRegistry uses the registry's colors (incl. custom types)", () => {
    const reg: ConceptTypeEntry[] = [
      { key: "domain", label: "Domain", color: "#111111", weight: 100, order: 0, hidden: false, builtin: true },
      { key: "risk", label: "Risk", color: "#ff0000", weight: 90, order: 1, hidden: false, builtin: false },
    ];
    const colors = typeColorsFromRegistry(reg);
    expect(colors.domain).toBe("#111111"); // recolored built-in
    expect(colors.risk).toBe("#ff0000"); // custom type
    expect(colors.pending).toBe(PENDING_TYPE_COLOR); // always present
  });

  it("colorForType defaults unknown/custom-absent types to the pending gray", () => {
    const colors = typeColorsFromRegistry([]);
    expect(colorForType("domain", colors)).toBe("#60a5fa");
    expect(colorForType("totally-unknown", colors)).toBe(PENDING_TYPE_COLOR);
  });
});
