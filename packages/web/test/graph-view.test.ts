import { describe, expect, it } from "vitest";
import {
  ALL_NODE_TYPES,
  DEFAULT_ON_TYPES,
  allEnabledTypes,
  clampToViewport,
  cullEdge,
  defaultEnabledTypes,
  focusRevealSet,
  isDimmed,
  isEdgeDimmed,
  isInViewport,
  radiusForTypeDegree,
  typeClusterCenter,
  typeSizeScale,
  viewportRect,
  type FocusEdge,
  type ViewportRect,
} from "../frontend/graph-view.js";

describe("default node-type loading (graph-view)", () => {
  it("defaults on the high-signal structural types only", () => {
    expect(defaultEnabledTypes()).toEqual(new Set(["domain", "feature", "spec", "story"]));
    // Same content, order-independent, as the exported ranking.
    expect(new Set(DEFAULT_ON_TYPES)).toEqual(defaultEnabledTypes());
  });

  it("leaves low-signal + high-cardinality types off by default", () => {
    const on = defaultEnabledTypes();
    for (const t of ["workflow", "decision", "task", "constraint", "pattern", "glossary", "concept", "pending"]) {
      expect(on.has(t)).toBe(false);
    }
  });

  it("returns a fresh mutable set each call (no shared state)", () => {
    const a = defaultEnabledTypes();
    a.add("task");
    expect(defaultEnabledTypes().has("task")).toBe(false);
  });

  it("allEnabledTypes covers every known type", () => {
    expect(allEnabledTypes()).toEqual(new Set(ALL_NODE_TYPES));
    expect(allEnabledTypes().size).toBe(12); // 11 concept types + "pending"
  });
});

describe("viewportRect (graph-view)", () => {
  it("inverts identity transform to screen bounds", () => {
    const vp = viewportRect(800, 600, { x: 0, y: 0, k: 1 });
    expect(vp).toEqual({ minX: 0, minY: 0, maxX: 800, maxY: 600 });
  });

  it("accounts for pan and zoom", () => {
    // translate(100,50) scale(2): screen (0,0) maps to graph (-50,-25).
    const vp = viewportRect(800, 600, { x: 100, y: 50, k: 2 });
    expect(vp.minX).toBe(-50);
    expect(vp.minY).toBe(-25);
    expect(vp.maxX).toBe((800 - 100) / 2);
    expect(vp.maxY).toBe((600 - 50) / 2);
  });

  it("widens the rect by pad in graph units", () => {
    const vp = viewportRect(800, 600, { x: 0, y: 0, k: 1 }, 30);
    expect(vp).toEqual({ minX: -30, minY: -30, maxX: 830, maxY: 630 });
  });
});

describe("isInViewport (graph-view)", () => {
  const vp: ViewportRect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it("keeps nodes inside the rect", () => {
    expect(isInViewport(50, 50, 5, vp)).toBe(true);
  });

  it("is boundary-inclusive: a circle just touching the edge counts", () => {
    expect(isInViewport(-5, 50, 5, vp)).toBe(true); // right rim touches minX=0
    expect(isInViewport(105, 50, 5, vp)).toBe(true); // left rim touches maxX=100
  });

  it("drops nodes fully outside the rect", () => {
    expect(isInViewport(-6, 50, 5, vp)).toBe(false); // rim at -1, still left of 0
    expect(isInViewport(50, 120, 5, vp)).toBe(false);
  });
});

describe("clampToViewport (graph-view)", () => {
  const vp: ViewportRect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it("leaves interior points untouched", () => {
    expect(clampToViewport(40, 60, vp)).toEqual([40, 60]);
  });

  it("snaps off-screen points to the nearest edge", () => {
    expect(clampToViewport(-30, 40, vp)).toEqual([0, 40]);
    expect(clampToViewport(200, 200, vp)).toEqual([100, 100]);
  });
});

describe("cullEdge (graph-view)", () => {
  const vp: ViewportRect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const a = { x: 20, y: 20 }; // inside
  const b = { x: 200, y: 20 }; // off-screen to the right

  it("draws the full edge when both endpoints are visible", () => {
    const inB = { x: 80, y: 80 };
    const res = cullEdge(a, inB, true, true, vp);
    expect(res.kind).toBe("full");
    if (res.kind === "full") {
      expect(res.ends).toEqual({ x1: 20, y1: 20, x2: 80, y2: 80 });
    }
  });

  it("drops the edge when neither endpoint is visible", () => {
    expect(cullEdge(b, { x: 300, y: 20 }, false, false, vp)).toEqual({ kind: "drop" });
  });

  it("stubs a visible→offscreen edge to the nearest on-screen point (target clamped)", () => {
    const res = cullEdge(a, b, true, false, vp);
    expect(res.kind).toBe("stub");
    if (res.kind === "stub") {
      // Source endpoint stays put; the off-screen target snaps to the viewport edge.
      expect(res.ends.x1).toBe(20);
      expect(res.ends.y1).toBe(20);
      expect(res.ends.x2).toBe(100); // clamped to maxX
      expect(res.ends.y2).toBe(20);
    }
  });

  it("stubs an offscreen→visible edge (source clamped)", () => {
    const res = cullEdge(b, a, false, true, vp);
    expect(res.kind).toBe("stub");
    if (res.kind === "stub") {
      expect(res.ends.x1).toBe(100); // off-screen source clamped to maxX
      expect(res.ends.y1).toBe(20);
      expect(res.ends.x2).toBe(20); // visible target untouched
      expect(res.ends.y2).toBe(20);
    }
  });
});

describe("sticky click focus (graph-view)", () => {
  // a→b, c→a, b→d; e isolated.
  const edges: FocusEdge[] = [
    { from: "a", to: "b" },
    { from: "c", to: "a" },
    { from: "b", to: "d" },
  ];

  it("focusRevealSet is empty with no focus", () => {
    expect(focusRevealSet(null, edges).size).toBe(0);
  });

  it("focusRevealSet includes focused node + 1-hop neighbors both directions", () => {
    expect([...focusRevealSet("a", edges)].sort()).toEqual(["a", "b", "c"]);
    expect(focusRevealSet("a", edges).has("d")).toBe(false); // 2 hops away
  });

  it("focusRevealSet reveals only itself for an isolated node", () => {
    expect([...focusRevealSet("e", edges)]).toEqual(["e"]);
  });

  it("isDimmed: nothing dims with empty reveal; non-members dim otherwise", () => {
    expect(isDimmed("x", new Set())).toBe(false);
    const reveal = new Set(["a", "b", "c"]);
    expect(isDimmed("a", reveal)).toBe(false);
    expect(isDimmed("z", reveal)).toBe(true);
  });

  it("isEdgeDimmed: only edges touching the focused node stay lit", () => {
    expect(isEdgeDimmed("a", "b", null)).toBe(false); // no focus
    expect(isEdgeDimmed("a", "b", "a")).toBe(false); // touches focus
    expect(isEdgeDimmed("c", "a", "a")).toBe(false); // touches focus (incoming)
    expect(isEdgeDimmed("b", "d", "a")).toBe(true); // does not touch focus
  });
});

describe("type size + clustering (graph-view)", () => {
  it("ranks concept largest, then domain, down to pending", () => {
    expect(typeSizeScale("concept")).toBeGreaterThan(typeSizeScale("domain"));
    expect(typeSizeScale("domain")).toBeGreaterThan(typeSizeScale("feature"));
    expect(typeSizeScale("glossary")).toBeGreaterThan(typeSizeScale("pending"));
    expect(typeSizeScale("unknown")).toBe(1);
  });

  it("radiusForTypeDegree scales the degree curve by type and grows with degree", () => {
    expect(radiusForTypeDegree("concept", 9)).toBeGreaterThan(radiusForTypeDegree("glossary", 9));
    expect(radiusForTypeDegree("feature", 16)).toBeGreaterThan(radiusForTypeDegree("feature", 1));
  });

  it("typeClusterCenter spreads types on a ring and centers unknowns", () => {
    const types = ["a", "b", "c", "d"];
    expect(typeClusterCenter("zzz", types, 800, 600)).toEqual({ x: 400, y: 300 });
    const first = typeClusterCenter("a", types, 800, 600, 100);
    expect(first.x).toBeCloseTo(400);
    expect(first.y).toBeCloseTo(200); // first type sits directly above center
    for (const t of types) {
      const c = typeClusterCenter(t, types, 800, 600, 120);
      expect(Math.hypot(c.x - 400, c.y - 300)).toBeCloseTo(120);
    }
  });
});
