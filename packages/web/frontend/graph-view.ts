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

// -------------------------------------------------------- semantic zoom LOD
// Level-of-detail as you zoom: furthest out shows only the top-signal type
// (domains); zooming in progressively unfolds lower-signal tiers. Mirrors the
// cloud app's pure LOD logic (apps/cloud/src/lib/graph-view.ts) so both viewers
// share one ranking + threshold curve. NOTE: the static web viewer's main.ts
// does not yet wire this into its zoom handler / add an auto-mode toggle — only
// the pure function is mirrored here (the interactive wiring is cloud-only).
//
// SIGNAL RANKING (rank 0 = highest signal, shown at min zoom):
//   0: domain · 1: feature, spec, constraint · 2: story, workflow, pattern,
//   decision · 3: glossary, concept, task · 4: pending (lowest).
// THRESHOLD CURVE: a rank r becomes visible once scale crosses a threshold
// spaced linearly across [LOD_MIN_SCALE, LOD_MAX_SCALE]; a ±LOD_HYSTERESIS
// dead-band (using the previous set) stops flicker at a boundary. Monotonic:
// zooming in only ever adds types.

export const TYPE_SIGNAL_RANK: Record<string, number> = {
  domain: 0,
  feature: 1,
  spec: 1,
  constraint: 1,
  story: 2,
  workflow: 2,
  pattern: 2,
  decision: 2,
  glossary: 3,
  concept: 3,
  task: 3,
  pending: 4,
};

export const MAX_SIGNAL_RANK = 4;

/** Signal rank for a type (unknown → MAX_SIGNAL_RANK: revealed last, never never). */
export function signalRank(type: string): number {
  return TYPE_SIGNAL_RANK[type] ?? MAX_SIGNAL_RANK;
}

export const LOD_MIN_SCALE = 0.3;
export const LOD_MAX_SCALE = 2.2;
export const LOD_HYSTERESIS = 0.1;

/** Scale threshold at which a given rank first becomes eligible. */
export function lodThresholdForRank(rank: number, maxRank = MAX_SIGNAL_RANK): number {
  if (maxRank <= 0) return LOD_MIN_SCALE;
  const clamped = Math.max(0, Math.min(maxRank, rank));
  return LOD_MIN_SCALE + (clamped / maxRank) * (LOD_MAX_SCALE - LOD_MIN_SCALE);
}

/**
 * Types visible at a given d3 zoom `scale`, derived from the signal ranking +
 * threshold curve. Domains-only at/below LOD_MIN_SCALE; all types once zoomed
 * past LOD_MAX_SCALE; monotonic in scale. Pass `prev` (the previously-visible
 * set) for hysteresis so a small wiggle at a threshold doesn't toggle a type.
 */
export function typesVisibleAtZoom(
  scale: number,
  opts: { types?: readonly string[]; prev?: Set<string> | null } = {},
): Set<string> {
  const types = opts.types ?? ALL_NODE_TYPES;
  const prev = opts.prev ?? null;
  const out = new Set<string>();
  for (const type of types) {
    const rank = signalRank(type);
    if (rank <= 0) {
      out.add(type); // domains are the always-on baseline
      continue;
    }
    const threshold = lodThresholdForRank(rank);
    const wasOn = prev?.has(type) ?? false;
    const on = wasOn
      ? scale >= threshold * (1 - LOD_HYSTERESIS)
      : scale >= threshold * (1 + LOD_HYSTERESIS);
    if (on) out.add(type);
  }
  return out;
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

// ------------------------------------------------------- type size + clustering
// Nodes are sized by concept type (generality) and same-type nodes share a
// cluster center so each type forms a discrete cloud that overlaps others as
// cross-type edges pull them together. Mirrors apps/cloud/src/lib/graph-view.ts.

/** Per-type size rank — a multiplier on the degree-driven base radius. */
export const TYPE_SIZE_SCALE: Record<string, number> = {
  concept: 1.9,
  domain: 1.6,
  feature: 1.3,
  story: 1.2,
  spec: 1.2,
  workflow: 1.1,
  task: 1.0,
  decision: 1.0,
  constraint: 0.95,
  pattern: 0.95,
  glossary: 0.9,
  pending: 0.8,
};

/** Size multiplier for a concept type (1.0 for anything unranked). */
export function typeSizeScale(type: string): number {
  return TYPE_SIZE_SCALE[type] ?? 1;
}

/** Node radius from BOTH concept type (base scope) and degree (connectedness). */
export function radiusForTypeDegree(type: string, degree: number): number {
  return (6 + Math.sqrt(Math.max(0, degree)) * 2.4) * typeSizeScale(type);
}

/**
 * Cluster center (graph coords) for a concept type: types spread evenly around
 * a circle so each type's nodes gravitate into a distinct cloud. `types` fixes
 * the ordering; a missing type / empty list falls back to the canvas center.
 */
export function typeClusterCenter(
  type: string,
  types: string[],
  width: number,
  height: number,
  radius?: number,
): { x: number; y: number } {
  const cx = width / 2;
  const cy = height / 2;
  const i = types.indexOf(type);
  if (i < 0 || types.length <= 1) return { x: cx, y: cy };
  const r = radius ?? Math.min(width, height) * 0.35;
  const angle = (i / types.length) * Math.PI * 2 - Math.PI / 2;
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

// ------------------------------------------------------------- click focus
// Sticky node focus (distinct from the transient hover-neighborhood highlight):
// clicking a node dims all non-neighbors and reveals its 1-hop neighbors even
// when their concept type is toggled off in the type filter. Pure helpers here;
// the DOM wiring lives in main.ts. Mirrors apps/cloud/src/lib/graph-view.ts.

/** Minimal edge shape these helpers need. */
export interface FocusEdge {
  from: string;
  to: string;
}

/**
 * The focus-reveal set for a focused node: the focused id plus every node one
 * undirected hop away (edges followed in BOTH directions). Empty when nothing
 * is focused; an isolated node reveals only itself.
 */
export function focusRevealSet(focusedId: string | null, edges: FocusEdge[]): Set<string> {
  const set = new Set<string>();
  if (!focusedId) return set;
  set.add(focusedId);
  for (const e of edges) {
    if (e.from === focusedId) set.add(e.to);
    if (e.to === focusedId) set.add(e.from);
  }
  return set;
}

/** Is a node dimmed under focus? Nothing dims with an empty reveal set. */
export function isDimmed(id: string, revealSet: Set<string>): boolean {
  if (revealSet.size === 0) return false;
  return !revealSet.has(id);
}

/**
 * Is an edge dimmed under focus? An edge stays lit only if it connects the
 * focused node to a neighbor (focused id is one endpoint); others dim. Nothing
 * dims when no node is focused.
 */
export function isEdgeDimmed(from: string, to: string, focusedId: string | null): boolean {
  if (!focusedId) return false;
  return from !== focusedId && to !== focusedId;
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
