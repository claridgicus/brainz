// Pure feature-tree model for /v/[slug]/features (SPEC-CLOUD.md "Feature
// tree"): the project as one top-down hierarchy, domain → epic → feature
// (→ sub-feature / story) → task, with a task roll-up on every node. No
// Svelte, no DOM, so it is unit-tested and the page only renders it.
//
// Hierarchy edges are the membership relations (part_of, realizes) walked
// from child to parent. Roll-ups count each node's burndown scope closure
// (`scopeClosure`, @brainz/engine), so a node's numbers match the board's
// epic lanes and the burndown for the same scope.
import type { GraphPayload, TaskMeta } from "@brainz/contracts";
import { MEMBERSHIP_RELATIONS } from "@brainz/engine";
import {
	type EpicRollup,
	type Status,
	epicRollup,
	statusOf,
} from "../routes/(app)/v/[slug]/board/board-lanes";

/** Concept types that appear in the tree, in child-sort order. */
export const TREE_TYPES = ["domain", "epic", "feature", "story", "task"] as const;
/** Types that may sit at the top level; any other parentless node is "Unplaced". */
const ROOT_TYPES = new Set(["domain", "epic"]);
const TYPE_RANK = new Map<string, number>(TREE_TYPES.map((t, i) => [t, i]));

/** Id of the virtual "Unplaced" root (not a valid slug, so never a concept id). */
export const UNPLACED = "_unplaced";
export const UNPLACED_LABEL = "Unplaced";

export type TreeState = "empty" | "not-started" | "in-progress" | "done" | "blocked";

export interface TreeRollup extends EpicRollup {
	/** Tasks not done that carry a `needs-*` tag. */
	blocked: number;
}

export interface TreeNode {
	id: string;
	title: string;
	/** Concept type, or "unplaced" for the virtual root. */
	type: string;
	/** Primary parent id; null for a root (the Unplaced root included). */
	parent: string | null;
	/** Child ids in display order (type rank, then title, then id). */
	children: string[];
	/** Further membership parents, shown as a badge / ghost edges (never duplicated). */
	otherParents: string[];
	/** 0 for roots. */
	depth: number;
	rollup: TreeRollup;
	state: TreeState;
	/** Set on task nodes: their own status and claim. */
	task?: { status: Status; takenBy?: string; blocked: boolean };
}

export interface FeatureTree {
	/** Root ids: domains, then epics (by title), then Unplaced when non-empty. */
	roots: string[];
	nodes: Map<string, TreeNode>;
}

/** scopeClosure's hop cap (@brainz/engine burndown.ts). */
const CLOSURE_HOPS = 6;

const isNeedsTag = (tag: string): boolean => tag.toLowerCase().startsWith("needs-");

/** Whether a task counts as blocked: not done and tagged `needs-*`. */
export const isBlockedTask = (t: Pick<TaskMeta, "tags" | "taskStatus">): boolean =>
	statusOf(t as TaskMeta) !== "done" && t.tags.some(isNeedsTag);

/** Roll-up of a set of tasks: the board's epic roll-up plus the blocked count. */
export function treeRollup(tasks: readonly TaskMeta[]): TreeRollup {
	return { ...epicRollup(tasks), blocked: tasks.filter(isBlockedTask).length };
}

/**
 * A node's state from its roll-up: blocked wins (a blocked task inside, or the
 * node's own `needs-*` tag while unfinished), then done (every task done),
 * in progress (anything taken or done), not started; "empty" with no tasks.
 */
export function stateOf(rollup: TreeRollup, ownTags: readonly string[] = []): TreeState {
	const finished = rollup.total > 0 && rollup.done === rollup.total;
	if (rollup.blocked > 0 || (!finished && ownTags.some(isNeedsTag))) return "blocked";
	if (rollup.total === 0) return "empty";
	if (finished) return "done";
	if (rollup.done + rollup.taken > 0) return "in-progress";
	return "not-started";
}

/**
 * Build the tree from the graph payload and the task list (the board's two
 * payloads; no extra endpoint). Task status and claim come from the task
 * list; a task the graph doesn't know yet (just created) still appears,
 * under Unplaced, until the next graph refresh.
 *
 * Parents: a node's membership targets that are tree nodes, `part_of` before
 * `realizes`, then edge order. The first one that does not close a cycle is
 * the primary parent; the rest are `otherParents`. Nodes are placed in id
 * order, so the result is deterministic and a cycle's last-placed member
 * becomes a root (a domain/epic) or goes to Unplaced. No subtree is ever
 * duplicated.
 */
export function buildFeatureTree(graph: GraphPayload, tasks: readonly TaskMeta[]): FeatureTree {
	const taskById = new Map(tasks.map((t) => [t.id, t]));
	const nodes = new Map<string, TreeNode>();
	const tagsOf = new Map<string, readonly string[]>();
	const blank = (): TreeRollup => ({ ...epicRollup([]), blocked: 0 });

	for (const n of graph.nodes) {
		if (n.pending || !TYPE_RANK.has(n.type)) continue;
		nodes.set(n.id, {
			id: n.id,
			title: n.title,
			type: n.type,
			parent: null,
			children: [],
			otherParents: [],
			depth: 0,
			rollup: blank(),
			state: "empty",
		});
		tagsOf.set(n.id, n.tags);
	}
	for (const t of tasks) {
		if (nodes.has(t.id)) {
			tagsOf.set(t.id, t.tags);
			continue;
		}
		nodes.set(t.id, {
			id: t.id,
			title: t.title,
			type: "task",
			parent: null,
			children: [],
			otherParents: [],
			depth: 0,
			rollup: blank(),
			state: "empty",
		});
		tagsOf.set(t.id, t.tags);
	}

	// Candidate parents per node, part_of first then realizes, edge order.
	const membership = graph.edges.filter((e) => MEMBERSHIP_RELATIONS.includes(e.relation));
	const candidates = new Map<string, string[]>();
	for (const rel of MEMBERSHIP_RELATIONS) {
		for (const e of membership) {
			if (e.relation !== rel || e.from === e.to) continue;
			if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
			const list = candidates.get(e.from) ?? [];
			if (!list.includes(e.to)) list.push(e.to);
			candidates.set(e.from, list);
		}
	}

	// Primary parent: the first candidate whose ancestor chain (as assigned so
	// far) does not lead back to the node, so the parent map stays acyclic.
	const createsCycle = (child: string, parent: string): boolean => {
		for (let at: string | null = parent; at !== null; at = nodes.get(at)!.parent) {
			if (at === child) return true;
		}
		return false;
	};
	const ids = [...nodes.keys()].sort();
	for (const id of ids) {
		const node = nodes.get(id)!;
		for (const c of candidates.get(id) ?? []) {
			if (node.parent === null && !createsCycle(id, c)) node.parent = c;
			else node.otherParents.push(c);
		}
	}

	// Roots and Unplaced.
	const unplaced: string[] = [];
	const roots: string[] = [];
	for (const id of ids) {
		const node = nodes.get(id)!;
		if (node.parent !== null) nodes.get(node.parent)!.children.push(id);
		else if (ROOT_TYPES.has(node.type)) roots.push(id);
		else unplaced.push(id);
	}
	const byDisplay = (a: string, b: string): number => {
		const x = nodes.get(a)!;
		const y = nodes.get(b)!;
		return (
			(TYPE_RANK.get(x.type) ?? 99) - (TYPE_RANK.get(y.type) ?? 99) ||
			x.title.localeCompare(y.title) ||
			x.id.localeCompare(y.id)
		);
	};
	for (const node of nodes.values()) node.children.sort(byDisplay);
	roots.sort(byDisplay);
	unplaced.sort(byDisplay);
	if (unplaced.length > 0) {
		nodes.set(UNPLACED, {
			id: UNPLACED,
			title: UNPLACED_LABEL,
			type: "unplaced",
			parent: null,
			children: unplaced,
			otherParents: [],
			depth: 0,
			rollup: blank(),
			state: "empty",
		});
		for (const id of unplaced) nodes.get(id)!.parent = UNPLACED;
		roots.push(UNPLACED);
	}

	// Depths, top-down (iterative: a long part_of chain must not overflow).
	const stack: [string, number][] = roots.map((id) => [id, 0]);
	while (stack.length > 0) {
		const [id, depth] = stack.pop()!;
		const node = nodes.get(id)!;
		node.depth = depth;
		for (const c of node.children) stack.push([c, depth + 1]);
	}

	// Roll-ups: each node's scope closure, restricted to tasks. A task is in
	// X's closure exactly when X is at most CLOSURE_HOPS membership hops out
	// from the task, so one outward walk per task fills every node's member
	// list (scopeClosure per node would rescan every edge for each node; the
	// tests check the two agree). A task node counts itself (plus any
	// subtasks). Unplaced rolls up the union of its children's tasks.
	const taskOf = (id: string): TaskMeta | undefined => {
		const t = taskById.get(id);
		if (t) return t;
		const n = nodes.get(id);
		if (n?.type !== "task") return undefined;
		return { id, title: n.title, type: "task", status: "active", tags: [...(tagsOf.get(id) ?? [])] } as TaskMeta;
	};
	const out = new Map<string, string[]>();
	for (const e of membership) {
		const list = out.get(e.from);
		if (list) list.push(e.to);
		else out.set(e.from, [e.to]);
	}
	const memberTasks = new Map<string, TaskMeta[]>();
	const credit = (id: string, t: TaskMeta) => {
		if (!nodes.has(id)) return;
		const list = memberTasks.get(id);
		if (list) list.push(t);
		else memberTasks.set(id, [t]);
	};
	for (const node of nodes.values()) {
		if (node.type !== "task") continue;
		const t = taskOf(node.id)!;
		credit(node.id, t);
		const seen = new Set([node.id]);
		let frontier = [node.id];
		for (let hop = 0; hop < CLOSURE_HOPS && frontier.length > 0; hop++) {
			const next: string[] = [];
			for (const from of frontier) {
				for (const to of out.get(from) ?? []) {
					if (seen.has(to)) continue;
					seen.add(to);
					credit(to, t);
					next.push(to);
				}
			}
			frontier = next;
		}
	}
	for (const node of nodes.values()) {
		if (node.id === UNPLACED) continue;
		node.rollup = treeRollup(memberTasks.get(node.id) ?? []);
		node.state = stateOf(node.rollup, tagsOf.get(node.id));
		if (node.type === "task") {
			const own = taskOf(node.id)!;
			node.task = { status: statusOf(own), takenBy: own.takenBy, blocked: isBlockedTask(own) };
		}
	}
	const top = nodes.get(UNPLACED);
	if (top) {
		const seen = new Map<string, TaskMeta>();
		for (const c of top.children) for (const t of memberTasks.get(c) ?? []) seen.set(t.id, t);
		top.rollup = treeRollup([...seen.values()]);
		top.state = stateOf(top.rollup);
	}
	return { roots, nodes };
}

// ------------------------------------------------------------ expansion

/** Ids of every node with children (what "Expand all" opens). */
export function expandableIds(tree: FeatureTree): Set<string> {
	const out = new Set<string>();
	for (const n of tree.nodes.values()) if (n.children.length > 0) out.add(n.id);
	return out;
}

/**
 * The default expanded set: nodes above `depth` levels open, deeper levels
 * collapsed, so a large vault opens small. Nodes added later start collapsed.
 */
export function defaultExpanded(tree: FeatureTree, depth = 2): Set<string> {
	const out = new Set<string>();
	for (const n of tree.nodes.values()) if (n.children.length > 0 && n.depth < depth) out.add(n.id);
	return out;
}

/** Ids on the path from the root down to `id` (excluding `id`), to reveal it. */
export function ancestorsOf(tree: FeatureTree, id: string): string[] {
	const out: string[] = [];
	for (let at = tree.nodes.get(id)?.parent ?? null; at !== null; at = tree.nodes.get(at)?.parent ?? null) {
		out.unshift(at);
	}
	return out;
}

// --------------------------------------------------------------- layout

export type Orientation = "tb" | "lr";

export interface LayoutOptions {
	orientation: Orientation;
	nodeW: number;
	nodeH: number;
	/** Gap between siblings (breadth axis). */
	gapBreadth: number;
	/** Gap between levels (depth axis). */
	gapDepth: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
	orientation: "tb",
	nodeW: 210,
	nodeH: 64,
	gapBreadth: 18,
	gapDepth: 54,
};

export interface PlacedNode {
	id: string;
	/** Centre of the node box. */
	x: number;
	y: number;
	depth: number;
}

export interface TreeLayout {
	nodes: PlacedNode[];
	/** Primary parent → child links between placed nodes. */
	links: { from: string; to: string }[];
	width: number;
	height: number;
}

/**
 * A tidy tree over the expanded part of the tree: each visible leaf takes the
 * next slot along the breadth axis, a parent centres over its first and last
 * child, and depth sets the other axis. Top-down ("tb") or left-right ("lr").
 * Iterative, so deep trees don't overflow the stack.
 */
export function layoutTree(
	tree: FeatureTree,
	expanded: ReadonlySet<string>,
	opts: LayoutOptions = DEFAULT_LAYOUT,
): TreeLayout {
	const breadthStep = opts.orientation === "tb" ? opts.nodeW + opts.gapBreadth : opts.nodeH + opts.gapBreadth;
	const depthStep = opts.orientation === "tb" ? opts.nodeH + opts.gapDepth : opts.nodeW + opts.gapDepth;
	const slot = new Map<string, number>();
	const placed: PlacedNode[] = [];
	const links: { from: string; to: string }[] = [];
	let next = 0;
	let maxDepth = 0;
	const kids = (id: string): string[] => (expanded.has(id) ? tree.nodes.get(id)!.children : []);

	// Post-order: a node's slot is known once all its children are placed.
	for (const root of tree.roots) {
		const stack: { id: string; depth: number; i: number }[] = [{ id: root, depth: 0, i: 0 }];
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			const children = kids(top.id);
			if (top.i < children.length) {
				const child = children[top.i++];
				links.push({ from: top.id, to: child });
				stack.push({ id: child, depth: top.depth + 1, i: 0 });
				continue;
			}
			stack.pop();
			const s =
				children.length === 0
					? next++
					: (slot.get(children[0])! + slot.get(children[children.length - 1])!) / 2;
			slot.set(top.id, s);
			maxDepth = Math.max(maxDepth, top.depth);
			const b = s * breadthStep + breadthStep / 2;
			const d = top.depth * depthStep + depthStep / 2;
			placed.push(
				opts.orientation === "tb"
					? { id: top.id, x: b, y: d, depth: top.depth }
					: { id: top.id, x: d, y: b, depth: top.depth },
			);
		}
	}
	const breadth = next * breadthStep;
	const depth = (maxDepth + 1) * depthStep;
	return {
		nodes: placed,
		links,
		width: opts.orientation === "tb" ? breadth : depth,
		height: opts.orientation === "tb" ? depth : breadth,
	};
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Viewport culling: the placed nodes whose box meets `view` (tree
 * coordinates), and the links whose bounding box does, so the DOM only holds
 * what is on screen.
 */
export function cullLayout(
	layout: TreeLayout,
	view: Rect,
	opts: Pick<LayoutOptions, "nodeW" | "nodeH"> = DEFAULT_LAYOUT,
): { nodes: PlacedNode[]; links: { from: PlacedNode; to: PlacedNode }[] } {
	const hw = opts.nodeW / 2;
	const hh = opts.nodeH / 2;
	const box = (n: PlacedNode): Rect => ({ x: n.x - hw, y: n.y - hh, w: opts.nodeW, h: opts.nodeH });
	const at = new Map(layout.nodes.map((n) => [n.id, n]));
	const nodes = layout.nodes.filter((n) => overlaps(box(n), view));
	const links: { from: PlacedNode; to: PlacedNode }[] = [];
	for (const l of layout.links) {
		const a = at.get(l.from);
		const b = at.get(l.to);
		if (!a || !b) continue;
		const x = Math.min(a.x, b.x) - hw;
		const y = Math.min(a.y, b.y) - hh;
		const r = { x, y, w: Math.max(a.x, b.x) + hw - x, h: Math.max(a.y, b.y) + hh - y };
		if (overlaps(r, view)) links.push({ from: a, to: b });
	}
	return { nodes, links };
}

/** An elbow connector from a parent box to a child box. */
export function linkPath(
	from: Pick<PlacedNode, "x" | "y">,
	to: Pick<PlacedNode, "x" | "y">,
	opts: Pick<LayoutOptions, "orientation" | "nodeW" | "nodeH"> = DEFAULT_LAYOUT,
): string {
	if (opts.orientation === "tb") {
		const y1 = from.y + opts.nodeH / 2;
		const y2 = to.y - opts.nodeH / 2;
		const ym = (y1 + y2) / 2;
		return `M${from.x},${y1}V${ym}H${to.x}V${y2}`;
	}
	const x1 = from.x + opts.nodeW / 2;
	const x2 = to.x - opts.nodeW / 2;
	const xm = (x1 + x2) / 2;
	return `M${x1},${from.y}H${xm}V${to.y}H${x2}`;
}

/** Shorten a title to `max` characters with an ellipsis (SVG text doesn't wrap). */
export const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** The board, grouped by epic and filtered to a node's subtree (its closure). */
export const boardHrefFor = (slug: string, id: string): string =>
	`/v/${slug}/board?group=epic&scope=${encodeURIComponent(id)}`;
