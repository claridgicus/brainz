// Pure graph-view rendering helpers — no Svelte, no DOM — extracted so the
// culling / default-type logic in Graph.svelte can be unit-tested (mirrors the
// board-lanes.ts pattern). These functions decide *which elements belong in the
// DOM* for the current viewport; the force simulation stays elsewhere.

import type { Edge } from "@brainz/contracts";
import { ALL_TYPES } from "./graph-data.js";

/**
 * Default-on concept types on first load, ranked by usefulness / signal.
 *
 * HIGH-signal structural types drive the graph's shape and are what a reader
 * lands to explore: `domain` (the top-level areas), `feature` (what's being
 * built), `spec` (the contract), `story` (user-facing intent), and `task`
 * (default-on because the board links straight into the graph at a task node —
 * a task must be present for that pan-to to land on something). The remaining
 * types (workflow, decision, constraint, pattern, glossary, concept) are
 * lower-signal detail, hidden until the reader toggles them on.
 */
export const DEFAULT_VISIBLE_TYPES = ["domain", "feature", "spec", "story", "task"] as const;

/** Fresh array of the default-on types that actually exist in the palette. */
export function defaultVisibleTypes(): string[] {
	const all = new Set(ALL_TYPES);
	return DEFAULT_VISIBLE_TYPES.filter((t) => all.has(t));
}

// -------------------------------------------------------- semantic zoom LOD
// Level-of-detail as you zoom: furthest out the graph shows only the top-signal
// structural types (domains); zooming in progressively unfolds lower-signal
// types until, fully zoomed, everything is visible. This is the DEFAULT view
// mode ("auto") until the user manually touches a type-filter chip, which flips
// to "manual" and hands control to the chips.
//
// SIGNAL RANKING (rank 0 = highest signal, shown first / at min zoom):
//   rank 0: domain                              — top-level areas, the spine
//   rank 1: feature, spec, constraint           — what's built + its contracts
//   rank 2: story, workflow, pattern, decision  — behaviour + rationale
//   rank 3: glossary, concept, task             — leaf detail / high-cardinality
//   rank 4: pending                             — unresolved stubs, lowest signal
// Types within a rank appear together. Any unranked/unknown type is treated as
// the lowest rank so it only shows fully zoomed in (never hidden forever).
//
// THRESHOLD CURVE: the d3 zoom scale runs ~[LOD_MIN_SCALE, LOD_MAX_SCALE]
// (0.3 .. 2.2 — the meaningful band inside the wheel's 0.12..8 clamp; the default
// view opens at k=1, which lands on ranks 0-1). A rank r (of maxRank) becomes
// visible once the scale crosses its threshold, spaced evenly (linearly) across
// that band:
//   threshold(r) = LOD_MIN_SCALE + (r / maxRank) * (LOD_MAX_SCALE - LOD_MIN_SCALE)
// so rank 0 is visible at (and below) min scale, and the last rank only at max
// scale. Because a type is shown when scale >= its threshold, zooming IN is
// monotonic: it only ever ADDS types, never removes them.
//
// HYSTERESIS: to stop types flickering when the scale hovers on a threshold, we
// apply a symmetric dead-band. A rank turns ON at threshold*(1+LOD_HYSTERESIS)
// and only turns OFF again below threshold*(1-LOD_HYSTERESIS). The caller passes
// the previously-visible set (`prev`) so a rank that's already on stays on until
// the scale drops clearly below its threshold — a tiny wiggle at the boundary
// never toggles it.

/** Rank of each concept type; lower = higher signal, revealed earlier. */
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

/** The lowest-signal rank (unknown types fall back to this — shown only fully in). */
export const MAX_SIGNAL_RANK = 4;

/** Signal rank for a type (unknown → MAX_SIGNAL_RANK so it reveals last, never never). */
export function signalRank(type: string): number {
	return TYPE_SIGNAL_RANK[type] ?? MAX_SIGNAL_RANK;
}

/** d3 zoom scale at/below which only rank-0 (domains) show. */
export const LOD_MIN_SCALE = 0.3;
/** d3 zoom scale at/above which every rank (all types) shows. */
export const LOD_MAX_SCALE = 2.2;
/** Symmetric dead-band (fraction of a threshold) that a rank must clear to flip. */
export const LOD_HYSTERESIS = 0.1;

/** The scale threshold at which a given rank first becomes eligible. */
export function lodThresholdForRank(rank: number, maxRank = MAX_SIGNAL_RANK): number {
	if (maxRank <= 0) return LOD_MIN_SCALE;
	const clamped = Math.max(0, Math.min(maxRank, rank));
	return LOD_MIN_SCALE + (clamped / maxRank) * (LOD_MAX_SCALE - LOD_MIN_SCALE);
}

export interface TypesVisibleAtZoomOpts {
	/** Types to consider (defaults to the full palette). */
	types?: readonly string[];
	/**
	 * The set that was visible at the previous scale. Enables hysteresis: a rank
	 * already on stays on until the scale drops clearly below its threshold. Omit
	 * (or pass empty) for a fresh, hysteresis-free evaluation.
	 */
	prev?: Set<string> | null;
}

/**
 * The set of concept types visible at a given d3 zoom `scale`, derived purely
 * from the signal ranking + threshold curve above. Domains-only at/below
 * LOD_MIN_SCALE; every type at/above LOD_MAX_SCALE; monotonic in scale (zooming
 * in only adds types). With `opts.prev` supplied, applies hysteresis so a small
 * scale wiggle around a threshold doesn't toggle a type on/off.
 */
export function typesVisibleAtZoom(scale: number, opts: TypesVisibleAtZoomOpts = {}): Set<string> {
	const types = opts.types ?? ALL_TYPES;
	const prev = opts.prev ?? null;
	const out = new Set<string>();
	for (const type of types) {
		const rank = signalRank(type);
		// Rank 0 (domains) is the always-on baseline — the graph is never emptier
		// than "domains only", so no threshold/hysteresis applies to it.
		if (rank <= 0) {
			out.add(type);
			continue;
		}
		const threshold = lodThresholdForRank(rank);
		const wasOn = prev?.has(type) ?? false;
		// ON above the upper band; OFF below the lower band; inside the band keep
		// the previous state (hysteresis).
		const on = wasOn
			? scale >= threshold * (1 - LOD_HYSTERESIS)
			: scale >= threshold * (1 + LOD_HYSTERESIS);
		if (on) out.add(type);
	}
	return out;
}

/** Graph filter modes: LOD-driven ("auto") vs chip-driven ("manual"). */
export type FilterMode = "auto" | "manual";

/**
 * Resolve the EFFECTIVE visible-type set from the current mode: in "auto" the
 * LOD set (from `typesVisibleAtZoom`) drives visibility; in "manual" the user's
 * chip selection does. Returned as a fresh array (stable order = ALL_TYPES) so
 * it can seed the existing enabled-types state without surprises.
 */
export function effectiveVisibleTypes(
	mode: FilterMode,
	lodSet: Set<string>,
	manualSet: Set<string>,
	types: readonly string[] = ALL_TYPES,
): string[] {
	const chosen = mode === "auto" ? lodSet : manualSet;
	return types.filter((t) => chosen.has(t));
}

// ------------------------------------------------------- type size + clustering
// Nodes are sized by concept type (generality) so the graph reads as nested
// scopes: broad, structural types are large; leaf/detail types are small. Same-
// type nodes also share a cluster center so each type forms a discrete "cloud";
// cross-type edges pull two clouds to overlap Venn-diagram style. Both are pure
// so they can be unit-tested and mirrored to the static viewer.

/**
 * Per-type size rank — a multiplier on the degree-driven base radius. Larger =
 * more general/structural scope. `concept` (the broadest, catch-all knowledge
 * node) is biggest; `domain` next; then the feature/story/spec/workflow layer;
 * then leaf detail types (task/decision/constraint/pattern/glossary); `pending`
 * stubs are smallest. Unknown types fall back to 1.0.
 */
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

/**
 * Node radius from BOTH its type (base scope) and its degree (connectedness).
 * Keeps the existing degree curve (`6 + sqrt(degree)*2.4`) but scales it by the
 * type rank, so a highly-connected `concept` dwarfs a lone `glossary` entry.
 */
export function radiusForTypeDegree(type: string, degree: number): number {
	return (6 + Math.sqrt(Math.max(0, degree)) * 2.4) * typeSizeScale(type);
}

/**
 * Cluster center (in graph coords) for a concept type: types are spread evenly
 * around a circle centered on the canvas so each type's nodes gravitate into a
 * distinct cloud. `types` fixes the ordering (index → angle); a type absent from
 * the list, or an empty list, falls back to the canvas center. `radius` defaults
 * to ~35% of the smaller canvas dimension so clouds sit apart but overlap when
 * cross-type edges pull them together.
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
	const angle = (i / types.length) * Math.PI * 2 - Math.PI / 2; // first type at top
	return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

/** A viewport rectangle in *screen* (SVG-client) pixels. */
export interface ViewportRect {
	width: number;
	height: number;
}

/** The current pan/zoom transform: screen = graph * k + (x, y). */
export interface ViewTransform {
	x: number;
	y: number;
	k: number;
}

/** A positioned node — only id + post-force graph coords + radius matter here. */
export interface PositionedNode {
	id: string;
	x: number;
	y: number;
	r: number;
}

/** Project a node's graph-space centre into screen-space pixels. */
export function toScreen(n: PositionedNode, t: ViewTransform): { x: number; y: number } {
	return { x: n.x * t.k + t.x, y: n.y * t.k + t.y };
}

/**
 * Is a node (a circle of radius r) at all within the viewport rect, given the
 * current transform? `margin` (screen px) grows the test rect so nodes just
 * outside stay rendered — avoids pop-in at the edges while panning.
 */
export function isNodeInViewport(
	n: PositionedNode,
	t: ViewTransform,
	rect: ViewportRect,
	margin = 0,
): boolean {
	const s = toScreen(n, t);
	const rad = n.r * t.k + margin;
	return s.x + rad >= 0 && s.x - rad <= rect.width && s.y + rad >= 0 && s.y - rad <= rect.height;
}

/** Ids of the nodes whose current position falls inside the (margined) viewport. */
export function nodesInViewport(
	nodes: PositionedNode[],
	t: ViewTransform,
	rect: ViewportRect,
	margin = 0,
): Set<string> {
	const inView = new Set<string>();
	for (const n of nodes) {
		if (isNodeInViewport(n, t, rect, margin)) inView.add(n.id);
	}
	return inView;
}

export interface EdgeRenderPlan {
	edge: Edge;
	/** Both endpoints on-screen → draw the full line as normal. */
	full: boolean;
	/** Exactly one endpoint on-screen → draw a stub from it toward the other. */
	stub: boolean;
	/** Endpoint id that is on-screen (the stub's anchor); null for full edges. */
	anchorId: string | null;
	/** The off-screen endpoint the stub points at; null for full edges. */
	towardId: string | null;
}

/**
 * Classify each edge against the set of on-screen node ids:
 *   - both endpoints visible  → `full` (render the whole line)
 *   - exactly one visible      → `stub` (render a short line from the visible
 *     node toward the off-screen one, whose node element is dropped)
 *   - neither visible          → omitted entirely (not returned)
 *
 * Only edges whose *both* endpoints exist in `allIds` are considered — an edge
 * to a node that was filtered out by type never renders. `visibleIds` must be a
 * subset of the currently-simulated (type-filtered) node set.
 */
export function planEdges(
	edges: Edge[],
	visibleIds: Set<string>,
	allIds: Set<string>,
): EdgeRenderPlan[] {
	const plans: EdgeRenderPlan[] = [];
	for (const edge of edges) {
		if (!allIds.has(edge.from) || !allIds.has(edge.to)) continue;
		const fromVis = visibleIds.has(edge.from);
		const toVis = visibleIds.has(edge.to);
		if (fromVis && toVis) {
			plans.push({ edge, full: true, stub: false, anchorId: null, towardId: null });
		} else if (fromVis) {
			plans.push({ edge, full: false, stub: true, anchorId: edge.from, towardId: edge.to });
		} else if (toVis) {
			plans.push({ edge, full: false, stub: true, anchorId: edge.to, towardId: edge.from });
		}
		// neither visible → dropped
	}
	return plans;
}

/**
 * Convenience for the DOM layer: ids of the edges (as `from|to|relation`) that
 * should have a rendered element, plus which are stubs. Kept tiny — the Svelte
 * side already owns the line elements, this just answers "does it render?".
 */
export function stubEdgesFor(
	edges: Edge[],
	visibleIds: Set<string>,
	allIds: Set<string>,
): EdgeRenderPlan[] {
	return planEdges(edges, visibleIds, allIds).filter((p) => p.stub);
}

// ------------------------------------------------------------- click focus
// Sticky node focus (distinct from the transient hover-neighborhood highlight):
// clicking a node "focuses" it — the focused node and its DIRECT (1-hop)
// neighbors stay full opacity while everything else dims, and those neighbors
// are REVEALED even if their concept type is toggled off in the type filter.
// These pure helpers compute the reveal set and the dim predicates; the Svelte
// side owns the opacity classes + the render-set merge with viewport culling.

/**
 * The focus-reveal set for a focused node: the focused id plus every node one
 * undirected hop away (edges are followed in BOTH directions). Returns an empty
 * set when nothing is focused. An isolated node (no edges) reveals only itself.
 */
export function focusRevealSet(focusedId: string | null, edges: Edge[]): Set<string> {
	const set = new Set<string>();
	if (!focusedId) return set;
	set.add(focusedId);
	for (const e of edges) {
		if (e.from === focusedId) set.add(e.to);
		if (e.to === focusedId) set.add(e.from);
	}
	return set;
}

/**
 * Is a node dimmed under the current focus? Nothing is dimmed when no node is
 * focused (empty reveal set). While focused, a node dims iff it is NOT in the
 * reveal set (i.e. not the focused node and not a direct neighbor).
 */
export function isDimmed(id: string, revealSet: Set<string>): boolean {
	if (revealSet.size === 0) return false;
	return !revealSet.has(id);
}

/**
 * Is an edge dimmed under the current focus? While focused, an edge stays full
 * opacity only if it directly connects the focused node to one of its neighbors
 * (i.e. the focused id is one of its endpoints); every other edge dims. Nothing
 * dims when no node is focused.
 */
export function isEdgeDimmed(from: string, to: string, focusedId: string | null): boolean {
	if (!focusedId) return false;
	return from !== focusedId && to !== focusedId;
}

/**
 * Merge the viewport-culled id set with the focus-reveal set so focused-node
 * neighbors are never culled away (and off-type revealed neighbors render even
 * though the type filter would otherwise drop them). Returns a new set; the
 * inputs are untouched. With no focus this is just a copy of the culled set.
 */
export function mergeFocusRender(culledIds: Set<string>, revealSet: Set<string>): Set<string> {
	const out = new Set(culledIds);
	for (const id of revealSet) out.add(id);
	return out;
}

// ---------------------------------------------------------------- drag anchors
// A node the user drags and drops is *anchored* (pinned) at its drop point: its
// d3 fx/fy stay set so the sim treats it as fixed, and the position is persisted
// per-vault in localStorage so it restores on reload. These helpers are the pure
// serialize/apply/reset logic so the Svelte side just wires DOM events to them.

/** A saved anchor position in graph (sim) coordinates. */
export interface Anchor {
	x: number;
	y: number;
}

/** Map of nodeId → saved anchor. What we round-trip through localStorage. */
export type AnchorMap = Record<string, Anchor>;

/** localStorage key holding the anchor map for a given vault. */
export function anchorStorageKey(vaultId: string): string {
	return `brainz:graph:anchors:${vaultId}`;
}

/** localStorage key holding the LOD filter mode ("auto"/"manual") for a vault. */
export function filterModeStorageKey(vaultId: string): string {
	return `brainz:graph:filter-mode:${vaultId}`;
}

/** Coerce a stored value into a valid FilterMode, defaulting to "auto". */
export function parseFilterMode(raw: string | null | undefined): FilterMode {
	return raw === "manual" ? "manual" : "auto";
}

/** A minimal shape a d3 sim node satisfies — id plus mutable fixed coords. */
export interface AnchorableNode {
	id: string;
	x?: number | undefined;
	y?: number | undefined;
	fx?: number | null | undefined;
	fy?: number | null | undefined;
}

/**
 * Parse a stored anchor payload, tolerating anything malformed. Only entries
 * shaped `{ x:number, y:number }` (finite) survive; everything else is dropped
 * so a corrupt localStorage value degrades to "no anchors", never a throw.
 */
export function deserializeAnchors(raw: string | null | undefined): AnchorMap {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const out: AnchorMap = {};
	for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
		if (!val || typeof val !== "object") continue;
		const { x, y } = val as { x?: unknown; y?: unknown };
		if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
			out[id] = { x, y };
		}
	}
	return out;
}

/** Serialize an anchor map for storage (stable — plain JSON). */
export function serializeAnchors(anchors: AnchorMap): string {
	return JSON.stringify(anchors);
}

/**
 * Record (or update) one node's anchor, returning a *new* map (no mutation of
 * the input). Used on each drag end — dragging an already-anchored node just
 * overwrites its saved point.
 */
export function setAnchor(anchors: AnchorMap, id: string, pos: Anchor): AnchorMap {
	return { ...anchors, [id]: { x: pos.x, y: pos.y } };
}

/**
 * Pin every node that has a saved anchor: set fx/fy (and seed x/y so the first
 * frame draws it in place). Nodes with no anchor are left free (fx/fy untouched).
 * Mutates the nodes in place (d3 owns these objects) and returns the set of ids
 * that were anchored.
 */
export function applyAnchors(nodes: AnchorableNode[], anchors: AnchorMap): Set<string> {
	const applied = new Set<string>();
	for (const n of nodes) {
		const a = anchors[n.id];
		if (!a) continue;
		n.fx = a.x;
		n.fy = a.y;
		n.x = a.x;
		n.y = a.y;
		applied.add(n.id);
	}
	return applied;
}

/**
 * Un-pin every node (clear fx/fy) so a fresh layout can run. Mutates in place.
 * The Reset flow calls this before restarting the sim from scratch.
 */
export function clearAnchorsFromNodes(nodes: AnchorableNode[]): void {
	for (const n of nodes) {
		n.fx = null;
		n.fy = null;
	}
}
