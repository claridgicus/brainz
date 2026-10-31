// Pure level-of-detail + clustering logic for the cloud graph workspace (no
// DOM, no d3) so it is unit-testable and shared by Graph.svelte.
//
// Large vaults render HIERARCHICALLY: concepts are grouped into clusters (link
// communities — see graph-community.ts — named after their most central
// concept, normally a domain), each cluster lays its
// members out locally inside a disc ("footprint"), and only the cluster discs
// take part in the top-level force layout. A cluster draws as one bubble until
// it is big enough on screen and near enough to the viewport centre to expand
// (or the user picks Expand all / Collapse all), subject to a hard budget on
// individually rendered nodes. See SPEC-CLOUD.md
// ("Graph workspace — level of detail").
import type { Edge, GraphNode } from "@brainz/contracts";
import { detectCommunities } from "./graph-community.js";

/**
 * Vaults with more concepts than this use the clustered (hierarchical) layout.
 * Picked from `npm run perf:graph -- --extra flatmax=100000` (forced flat, every
 * type shown): flat holds ~55–60fps pan up to ~300 concepts and falls to 30–45fps
 * by 400, while the clustered layout is budget-capped at any size.
 */
export const FLAT_MAX_NODES = 300;
/** Default hard cap on individually rendered node elements (tuned for ~60fps). */
export const DEFAULT_NODE_BUDGET = 400;
/** Clusters larger than this are split (by type, then into chunks). */
export const MAX_CLUSTER_SIZE = 400;
/**
 * A collapsed cluster auto-expands once its footprint is at least this big on
 * screen (px radius) — low enough that the fitted overview of a few-hundred to
 * ~1000-concept vault opens its clusters (their discs fit at ~40–90px)…
 */
export const EXPAND_PX = 40;
/** …and an expanded one collapses again only below this (hysteresis, same ~0.7 ratio as before). */
export const COLLAPSE_PX = 28;
/**
 * …and only at or above this zoom scale (an open cluster stays open down to
 * 0.85× it): further out a member's mark is ~1px, so a counted bubble says
 * more, and opening 400 dots at the 2k/5k overview (fits at ~0.12) only costs
 * fps. Vaults up to ~1000 concepts fit at ~0.17–0.3, above it.
 */
export const MIN_AUTO_K = 0.15;
/** Score bonus (screen px) an already-expanded cluster gets in the budget race, so it never thrashes. */
export const STICKY_PX = 160;
/** Priority weight on a cluster's on-screen radius: bigger clusters claim the budget first. */
export const SIZE_PRIORITY = 0.5;
/**
 * An auto-expanded cluster must render at least this many members, and at least
 * this share of its counted size, else it stays a (counted) bubble — a hull
 * holding only its domain or two says less than the bubble's count.
 */
export const MIN_AUTO_MEMBERS = 2;
export const MIN_AUTO_SHARE = 0.2;
/** Clicking a bubble (or jumping into one) zooms until its footprint is this big on screen (px radius). */
export const OPEN_PX = 176;
/**
 * Auto (semantic-zoom) type LOD reads the zoom scale multiplied by these, so the
 * fitted overview shows domains plus rank-1 types (features, specs, constraints)
 * instead of domains alone. The cluster map fits at a much smaller scale than a
 * flat graph (~0.15–0.3 for up to ~1000 concepts vs ≥0.5) and clusters already
 * declutter it, hence the bigger boost; at the 2k/5k overview (~0.12) it is
 * still domains only, so those open as counted bubbles.
 */
export const TREE_LOD_BOOST = 5.5;
export const FLAT_LOD_BOOST = 1.7;
/**
 * Cluster expansion policy, chosen with the graph's Expand all / Collapse all
 * control and remembered per vault: `auto` = on-screen size decides; `all` =
 * every on-screen cluster competes for the budget whatever its size; `none` =
 * only clusters the user clicks open.
 */
export type ExpandPolicy = "auto" | "all" | "none";
export const EXPAND_POLICIES: readonly ExpandPolicy[] = ["auto", "all", "none"];
/** localStorage key holding a vault's expand policy. */
export const expandPolicyKey = (vaultId: string): string => `brainz:graph-expand:${vaultId}`;
/** Parse a stored policy; anything unknown → `auto`. */
export function parseExpandPolicy(raw: string | null | undefined): ExpandPolicy {
	return (EXPAND_POLICIES as readonly string[]).includes(raw ?? "") ? (raw as ExpandPolicy) : "auto";
}
/** Labels are cut to this many characters (full title stays in the tooltip). */
export const LABEL_MAX_CHARS = 26;
/** Approximate rendered width of one 11px label character. */
const LABEL_CHAR_PX = 6.3;

export interface Cluster {
	/** Stable unit id: `@c:<key>` — never collides with a concept slug. */
	id: string;
	title: string;
	/** Type used for the bubble's colour (the head's type; "concept" for the loose group). */
	type: string;
	/** The concept heading (and naming) this cluster: its most central member; null for the loose group. */
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

/** Title of the group holding concepts with no edges at all. */
export const LOOSE_TITLE = "Loose concepts";

/**
 * Group concepts into clusters by graph proximity: link communities from
 * `detectCommunities` (deterministic Louvain over the edge graph, seeded by
 * `part_of` roots), never by type. Each cluster is named after its most central
 * concept (a domain when it has one) and keyed `@c:<that concept's id>`; split
 * parts of an oversized community each get their own head. Concepts with no
 * edges at all share one "Loose concepts" group (`@c:~loose`, chunked past
 * `maxSize`).
 */
export function buildClusters(
	nodes: readonly GraphNode[],
	edges: readonly Edge[],
	maxSize = MAX_CLUSTER_SIZE,
): ClusterIndex {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const clusters = new Map<string, Cluster>();
	const clusterOf = new Map<string, string>();
	const add = (id: string, title: string, type: string, head: string | null, members: string[]): void => {
		clusters.set(id, { id, title, type, head, members });
		for (const m of members) clusterOf.set(m, id);
	};
	const { communities, loose } = detectCommunities(nodes, edges, maxSize);
	for (const c of communities) {
		const h = byId.get(c.head);
		add(`@c:${c.head}`, h?.title ?? c.head, h?.pending ? "pending" : (h?.type ?? "concept"), c.head, c.members);
	}
	const chunks = Math.ceil(loose.length / maxSize);
	for (let i = 0; i < chunks; i++) {
		const part = loose.slice(i * maxSize, (i + 1) * maxSize);
		add(`@c:~loose${chunks > 1 ? `/${i + 1}` : ""}`, `${LOOSE_TITLE}${chunks > 1 ? ` ${i + 1}` : ""}`, "concept", null, part);
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
 * cluster's footprint disc must intersect the (margined) viewport and, under the
 * `auto` policy, be big enough on screen — EXPAND_PX to open, COLLAPSE_PX to stay
 * open (hysteresis) — at a zoom of at least MIN_AUTO_K. `all` drops the size test; `none` admits only `manual`
 * (clicked-open) clusters. Lone concepts (size 1) qualify whenever on screen
 * (except under `none`). Sorted by priority: the distance from the viewport
 * centre to the disc's edge, minus a size bonus (bigger on screen first), a
 * sticky bonus for clusters already open and a large bonus for ones the user
 * opened.
 */
export function expansionCandidates(
	clusters: readonly ClusterGeom[],
	view: ViewState,
	prevExpanded: ReadonlySet<string>,
	manual: ReadonlySet<string> = new Set(),
	margin = 120,
	policy: ExpandPolicy = "auto",
): ExpansionCandidate[] {
	const cx = view.width / 2;
	const cy = view.height / 2;
	const out: ExpansionCandidate[] = [];
	for (const c of clusters) {
		const sx = c.x * view.k + view.x;
		const sy = c.y * view.k + view.y;
		const rho = c.R * view.k;
		const was = prevExpanded.has(c.id);
		const isManual = manual.has(c.id);
		const m = margin + (was ? 200 : 0);
		if (sx + rho < -m || sx - rho > view.width + m || sy + rho < -m || sy - rho > view.height + m) continue;
		if (!isManual) {
			if (policy === "none") continue;
			if (policy === "auto" && c.size > 1 && (rho < (was ? COLLAPSE_PX : EXPAND_PX) || view.k < MIN_AUTO_K * (was ? 0.85 : 1))) continue;
		}
		const d = Math.max(0, Math.hypot(sx - cx, sy - cy) - rho);
		out.push({ id: c.id, score: d - SIZE_PRIORITY * rho - (was ? STICKY_PX : 0) - (isManual ? 1e6 : 0) });
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
	return Math.min(maxK, Math.max(current, OPEN_PX / Math.max(1, R)));
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
