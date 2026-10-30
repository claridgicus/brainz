// Pure level-of-detail + clustering logic for the cloud graph workspace (no
// DOM, no d3) so it is unit-testable and shared by Graph.svelte.
//
// Large vaults render HIERARCHICALLY: concepts are grouped into clusters (the
// root of their `part_of` chain — a domain, normally), each cluster lays its
// members out locally inside a disc ("footprint"), and only the cluster discs
// take part in the top-level force layout. A cluster draws as one bubble until
// it is big enough on screen and near enough to the viewport centre to expand,
// subject to a hard budget on individually rendered nodes. See SPEC-CLOUD.md
// ("Graph workspace — level of detail").
import type { Edge, GraphNode } from "@brainz/contracts";

/** Vaults with more concepts than this use the clustered (hierarchical) layout. */
export const FLAT_MAX_NODES = 250;
/** Default hard cap on individually rendered node elements (tuned for ~60fps). */
export const DEFAULT_NODE_BUDGET = 400;
/** Clusters larger than this are split (by type, then into chunks). */
export const MAX_CLUSTER_SIZE = 400;
/** A collapsed cluster expands once its footprint is at least this big on screen (px radius)… */
export const EXPAND_PX = 110;
/** …and an expanded one collapses again only below this (hysteresis). */
export const COLLAPSE_PX = 80;
/** Score bonus (screen px) an already-expanded cluster gets in the budget race, so it never thrashes. */
export const STICKY_PX = 160;
/** Labels are cut to this many characters (full title stays in the tooltip). */
export const LABEL_MAX_CHARS = 26;
/** Approximate rendered width of one 11px label character. */
const LABEL_CHAR_PX = 6.3;

export interface Cluster {
	/** Stable unit id: `@c:<key>` — never collides with a concept slug. */
	id: string;
	title: string;
	/** Type used for the bubble's colour (the head's type, or the fallback type). */
	type: string;
	/** The concept heading this cluster (its `part_of` root), if any. */
	head: string | null;
	members: string[];
}

export interface ClusterIndex {
	clusters: Map<string, Cluster>;
	/** concept id → cluster id */
	clusterOf: Map<string, string>;
}

/** Truncate a label to LABEL_MAX_CHARS with an ellipsis. */
export function truncateLabel(title: string): string {
	return title.length > LABEL_MAX_CHARS ? `${title.slice(0, LABEL_MAX_CHARS - 1).trimEnd()}…` : title;
}

/**
 * Collision radius for a node sized to its label as well as its circle, so at
 * the default zoom neither circles nor (truncated) labels overlap.
 */
export function labelCollideRadius(title: string, r: number): number {
	const w = Math.min(title.length, LABEL_MAX_CHARS) * LABEL_CHAR_PX;
	return Math.max(r + 16, w / 2 + 8);
}

/**
 * Group concepts into clusters. Default grouping is the root of each concept's
 * `part_of` chain (followed transitively, cycle-safe): that is how a vault is
 * structured (features/stories/specs hang off domains), so clusters match the
 * domains people navigate by and are stable across edits. Concepts with no
 * `part_of` parent and no children fall back to one cluster per type
 * ("Unfiled spec", …). Oversized clusters are split by type, then into chunks.
 */
export function buildClusters(
	nodes: readonly GraphNode[],
	edges: readonly Edge[],
	maxSize = MAX_CLUSTER_SIZE,
): ClusterIndex {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const parent = new Map<string, string>();
	const hasChildren = new Set<string>();
	for (const e of edges) {
		if (e.relation !== "part_of" || e.from === e.to) continue;
		if (!byId.has(e.from) || !byId.has(e.to)) continue;
		if (!parent.has(e.from)) parent.set(e.from, e.to);
		hasChildren.add(e.to);
	}
	const rootOf = (id: string): string => {
		let cur = id;
		const seen = new Set([cur]);
		for (let i = 0; i < 16; i++) {
			const p = parent.get(cur);
			if (!p || seen.has(p)) break;
			seen.add(p);
			cur = p;
		}
		return cur;
	};
	const groups = new Map<string, { head: string | null; type: string; members: string[] }>();
	for (const n of nodes) {
		const root = rootOf(n.id);
		let key: string;
		let head: string | null = null;
		if (root !== n.id || hasChildren.has(n.id)) {
			key = root;
			head = root;
		} else {
			key = `~${n.pending ? "pending" : n.type}`;
		}
		let g = groups.get(key);
		if (!g) {
			const type = head ? (byId.get(head)?.type ?? n.type) : n.pending ? "pending" : n.type;
			g = { head, type, members: [] };
			groups.set(key, g);
		}
		g.members.push(n.id);
	}
	const clusters = new Map<string, Cluster>();
	const clusterOf = new Map<string, string>();
	const add = (id: string, title: string, type: string, head: string | null, members: string[]): void => {
		clusters.set(id, { id, title, type, head, members });
		for (const m of members) clusterOf.set(m, id);
	};
	const titleFor = (key: string, g: { head: string | null; type: string }): string =>
		g.head ? (byId.get(g.head)?.title ?? g.head) : `Unfiled ${g.type}`;
	for (const [key, g] of groups) {
		const title = titleFor(key, g);
		if (g.members.length <= maxSize) {
			add(`@c:${key}`, title, g.type, g.head, g.members);
			continue;
		}
		// Split: by type first (keeps the head with its own type's chunk)…
		const byType = new Map<string, string[]>();
		for (const m of g.members) {
			const t = byId.get(m)?.type ?? "concept";
			let list = byType.get(t);
			if (!list) byType.set(t, (list = []));
			list.push(m);
		}
		for (const [t, list] of byType) {
			// …then into fixed-size chunks in a stable (id) order.
			const sorted = [...list].sort();
			const chunks = Math.ceil(sorted.length / maxSize);
			for (let c = 0; c < chunks; c++) {
				const part = sorted.slice(c * maxSize, (c + 1) * maxSize);
				const head = g.head && part.includes(g.head) ? g.head : null;
				add(
					`@c:${key}/${t}${chunks > 1 ? `/${c + 1}` : ""}`,
					`${title} · ${t}${chunks > 1 ? ` ${c + 1}` : ""}`,
					head ? g.type : t,
					head,
					part,
				);
			}
		}
	}
	return { clusters, clusterOf };
}

export interface ClusterLink {
	a: string;
	b: string;
	weight: number;
}

/** Edges between clusters, aggregated (unordered pair → count). */
export function clusterLinks(index: ClusterIndex, edges: readonly Edge[]): ClusterLink[] {
	const agg = new Map<string, ClusterLink>();
	for (const e of edges) {
		const a = index.clusterOf.get(e.from);
		const b = index.clusterOf.get(e.to);
		if (!a || !b || a === b) continue;
		const [x, y] = a < b ? [a, b] : [b, a];
		const k = `${x}|${y}`;
		const l = agg.get(k);
		if (l) l.weight++;
		else agg.set(k, { a: x, b: y, weight: 1 });
	}
	return [...agg.values()];
}

/**
 * Footprint radius of a cluster from its members' collision radii: the disc a
 * local layout fits in at ~70% packing. Deterministic (no layout needed), so the
 * top-level layout reserves room for a cluster before it is ever expanded.
 */
export function clusterFootprint(collideRadii: readonly number[]): number {
	if (collideRadii.length <= 1) return collideRadii[0] ?? 20;
	let area = 0;
	for (const r of collideRadii) area += r * r;
	return Math.sqrt(area / 0.7) + 24;
}

/** Radius (graph units) of a collapsed cluster's bubble: scales with its footprint. */
export function bubbleRadius(footprint: number): number {
	return Math.max(22, footprint * 0.42);
}

// ------------------------------------------------------------ expansion

export interface ClusterGeom {
	id: string;
	/** centre in graph coords */
	x: number;
	y: number;
	/** footprint radius in graph units */
	R: number;
	/** members total (size 1 = a lone concept, always "expanded") */
	size: number;
}

export interface ViewState {
	x: number;
	y: number;
	k: number;
	width: number;
	height: number;
}

export interface ExpansionCandidate {
	id: string;
	/** lower = higher priority */
	score: number;
}

/**
 * Which clusters may render their members individually at this view: the
 * cluster's footprint disc must intersect the (margined) viewport and be big
 * enough on screen — EXPAND_PX to open, COLLAPSE_PX to stay open (hysteresis).
 * Lone concepts (size 1) qualify whenever on screen. Sorted by priority: the
 * distance from the viewport centre to the disc's edge, minus a sticky bonus
 * for clusters already open and a large bonus for ones the user opened.
 */
export function expansionCandidates(
	clusters: readonly ClusterGeom[],
	view: ViewState,
	prevExpanded: ReadonlySet<string>,
	manual: ReadonlySet<string> = new Set(),
	margin = 120,
): ExpansionCandidate[] {
	const cx = view.width / 2;
	const cy = view.height / 2;
	const out: ExpansionCandidate[] = [];
	for (const c of clusters) {
		const sx = c.x * view.k + view.x;
		const sy = c.y * view.k + view.y;
		const rho = c.R * view.k;
		const was = prevExpanded.has(c.id);
		const m = margin + (was ? 200 : 0);
		if (sx + rho < -m || sx - rho > view.width + m || sy + rho < -m || sy - rho > view.height + m) continue;
		if (c.size > 1 && !manual.has(c.id) && rho < (was ? COLLAPSE_PX : EXPAND_PX)) continue;
		const d = Math.max(0, Math.hypot(sx - cx, sy - cy) - rho);
		out.push({ id: c.id, score: d - (was ? STICKY_PX : 0) - (manual.has(c.id) ? 1e6 : 0) });
	}
	out.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1));
	return out;
}

/**
 * Share the node budget among candidates in priority order. `counts` = how many
 * eligible, on-screen members each would render. A candidate that fits is opened
 * fully; the first that doesn't fit is opened PARTIALLY (its members nearest the
 * centre, the rest folded into a "+N" bubble) when at least a quarter of it (or
 * 8 nodes) fits; everything after stays collapsed. Returns cluster id → number
 * of members allowed to render.
 */
export function allocateBudget(
	candidates: readonly ExpansionCandidate[],
	counts: ReadonlyMap<string, number>,
	budget: number,
): Map<string, number> {
	const out = new Map<string, number>();
	let remaining = Math.max(0, budget);
	for (const c of candidates) {
		const n = counts.get(c.id) ?? 0;
		if (n === 0) {
			out.set(c.id, 0);
			continue;
		}
		if (n <= remaining) {
			out.set(c.id, n);
			remaining -= n;
		} else if (remaining >= Math.min(n, Math.max(8, Math.ceil(n * 0.25)))) {
			out.set(c.id, remaining);
			remaining = 0;
		}
	}
	return out;
}

/**
 * Detail tiers: the `labelBudget` rendered nodes nearest the viewport centre
 * (and within `fullRadius` screen px of it) draw in full — label + glow; the
 * rest draw simplified (smaller mark, no label). `always` ids (selected,
 * hovered, focused) are always full.
 */
export function fullDetailIds(
	points: ReadonlyArray<{ id: string; sx: number; sy: number }>,
	view: Pick<ViewState, "width" | "height">,
	labelBudget: number,
	always: ReadonlySet<string> = new Set(),
	fullRadius = Math.hypot(view.width, view.height) * 0.42,
): Set<string> {
	const cx = view.width / 2;
	const cy = view.height / 2;
	const ranked = points
		.map((p) => ({ id: p.id, d: Math.hypot(p.sx - cx, p.sy - cy) }))
		.filter((p) => p.d <= fullRadius)
		.sort((a, b) => a.d - b.d);
	const out = new Set<string>();
	for (const id of always) out.add(id);
	for (const p of ranked) {
		if (out.size >= labelBudget + always.size) break;
		out.add(p.id);
	}
	return out;
}

/**
 * Zoom scale at which a cluster of footprint `R` opens comfortably (used when
 * the user clicks a bubble or jumps to a concept hidden inside one).
 */
export function expandScaleFor(R: number, current: number, maxK = 8): number {
	return Math.min(maxK, Math.max(current, (EXPAND_PX * 1.6) / Math.max(1, R)));
}

/** Phyllotaxis seed positions for discs of radius `radii` (largest first, centred on 0,0). */
export function spiralSeed(radii: readonly number[], pad = 40): Array<{ x: number; y: number }> {
	const order = radii.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);
	const out: Array<{ x: number; y: number }> = new Array(radii.length);
	let area = 0;
	const golden = Math.PI * (3 - Math.sqrt(5));
	order.forEach(({ r, i }, j) => {
		const dist = j === 0 ? 0 : Math.sqrt(area / Math.PI / 0.5);
		area += Math.PI * (r + pad) * (r + pad);
		out[i] = { x: Math.cos(j * golden) * dist, y: Math.sin(j * golden) * dist };
	});
	return out;
}
