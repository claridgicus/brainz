// Pure graph-view rendering helpers (no DOM) — unit-tested in test/graph-view.test.ts.
//
// These back two performance optimizations of the local viewer, mirroring the
// cloud app graph:
//   1. Default node-type loading by usefulness (only high-signal types render
//      on first load; toggles add/remove a type; off types leave the DOM).
//   2. Viewport culling (nodes outside the visible viewport are removed from the
//      DOM; an edge from a visible node to an off-screen node is drawn only as a
//      stub toward the nearest on-screen point).

/** All 11 concept types plus the synthesized "pending" pseudo-type. */
export const ALL_NODE_TYPES = [
  "concept",
  "domain",
  "feature",
  "story",
  "spec",
  "workflow",
  "task",
  "decision",
  "constraint",
  "pattern",
  "glossary",
  "pending",
] as const;

/**
 * Node types shown on first load, ranked by signal/usefulness. High-level
 * structural types (the "spine" of a vault) render by default; lower-signal or
 * high-cardinality types (tasks, decisions, constraints, patterns, glossary,
 * workflows, bare concepts, pending stubs) stay off until toggled on.
 */
export const DEFAULT_ON_TYPES = ["domain", "feature", "spec", "story"] as const;

/** A fresh mutable set of the default-on types (for the viewer's enabled-types state). */
export function defaultEnabledTypes(): Set<string> {
  return new Set<string>(DEFAULT_ON_TYPES);
}

/** A mutable set of every known type (the "show all" affordance). */
export function allEnabledTypes(): Set<string> {
  return new Set<string>(ALL_NODE_TYPES);
}

/** Axis-aligned viewport rectangle in *graph* coordinates (post-transform inverse). */
export interface ViewportRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Compute the visible viewport in graph coordinates from screen size and the
 * current pan/zoom transform (`translate(x,y) scale(k)`). A `pad` (in graph
 * units) widens the rect so nodes just off the edge are kept, avoiding a hard
 * pop-in during pans.
 */
export function viewportRect(
  screenWidth: number,
  screenHeight: number,
  view: { x: number; y: number; k: number },
  pad = 0,
): ViewportRect {
  const k = view.k || 1;
  const minX = (0 - view.x) / k - pad;
  const minY = (0 - view.y) / k - pad;
  const maxX = (screenWidth - view.x) / k + pad;
  const maxY = (screenHeight - view.y) / k + pad;
  return { minX, minY, maxX, maxY };
}

/**
 * Is a circle of radius `r` centered at (x, y) at all within the viewport?
 * Boundary-inclusive: a node exactly touching the edge counts as visible.
 */
export function isInViewport(
  x: number,
  y: number,
  r: number,
  vp: ViewportRect,
): boolean {
  return (
    x + r >= vp.minX &&
    x - r <= vp.maxX &&
    y + r >= vp.minY &&
    y - r <= vp.maxY
  );
}

/**
 * Clamp a point to the viewport rectangle — the nearest on-screen point to
 * (x, y). Used to terminate a stub edge that runs off-screen.
 */
export function clampToViewport(x: number, y: number, vp: ViewportRect): [number, number] {
  return [
    Math.min(Math.max(x, vp.minX), vp.maxX),
    Math.min(Math.max(y, vp.minY), vp.maxY),
  ];
}

export interface EdgeEndpoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type EdgeCullResult =
  | { kind: "drop" } // neither endpoint visible → no element
  | { kind: "full"; ends: EdgeEndpoints } // both visible → normal line
  | { kind: "stub"; ends: EdgeEndpoints }; // one visible → line toward nearest on-screen point

/**
 * Decide how to draw an edge given the viewport visibility of its endpoints.
 *
 * - both visible → draw in full.
 * - exactly one visible → draw a stub from the visible node toward the nearest
 *   on-screen point on the line to the off-screen node (the off-screen node
 *   element and its other off-screen edges are dropped elsewhere).
 * - neither visible → drop entirely.
 *
 * `x1,y1` is the source, `x2,y2` the target. The stub keeps the visible
 * endpoint fixed and clamps the invisible endpoint to the viewport edge.
 */
export function cullEdge(
  source: { x: number; y: number },
  target: { x: number; y: number },
  sourceVisible: boolean,
  targetVisible: boolean,
  vp: ViewportRect,
): EdgeCullResult {
  if (sourceVisible && targetVisible) {
    return { kind: "full", ends: { x1: source.x, y1: source.y, x2: target.x, y2: target.y } };
  }
  if (!sourceVisible && !targetVisible) {
    return { kind: "drop" };
  }
  if (sourceVisible) {
    const [x2, y2] = clampToViewport(target.x, target.y, vp);
    return { kind: "stub", ends: { x1: source.x, y1: source.y, x2, y2 } };
  }
  const [x1, y1] = clampToViewport(source.x, source.y, vp);
  return { kind: "stub", ends: { x1, y1, x2: target.x, y2: target.y } };
}
