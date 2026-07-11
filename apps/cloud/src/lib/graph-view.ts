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
