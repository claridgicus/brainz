// Pure board grouping/lane logic — no Svelte, no DOM — so it can be unit-tested
// and reused by the +page.svelte component. Grouping is client-side (see
// spec-board-grouping-client): the tasks endpoint returns one flat list and the
// board derives lanes from the task set + the concept graph payload.
import type { GraphPayload, TaskMeta } from "@brainz/contracts";
import { nearestContainer, scopeClosure } from "@brainz/engine";

export const STATUSES = ["open", "taken", "done"] as const;
export type Status = (typeof STATUSES)[number];
export type GroupBy = "status" | "concept" | "priority" | "takenBy" | "epic";

export interface Lane {
	id: string;
	label: string;
	status?: Status;
	tasks: TaskMeta[];
}

const PRIORITY_TAGS = ["critical", "high", "medium", "low"];

export const statusOf = (t: TaskMeta): Status => (t.taskStatus ?? "open") as Status;

export const priorityOf = (t: TaskMeta): string =>
	t.tags.find((tag) => PRIORITY_TAGS.includes(tag.toLowerCase())) ?? "unprioritized";

/** Title of a concept id from the graph payload, falling back to the id itself. */
export const titleForIn = (graph: GraphPayload, id: string): string =>
	graph.nodes.find((n) => n.id === id)?.title ?? id;

/** Ids a node points at via a given relation. */
export const edgesFromIn = (graph: GraphPayload, id: string, rel: string): string[] =>
	graph.edges.filter((e) => e.from === id && e.relation === rel).map((e) => e.to);

/** The concept a task belongs to for the "Concept" grouping: its part_of domain,
 * else what it realizes, else undefined (unlinked). */
export const conceptOf = (graph: GraphPayload, t: TaskMeta): string | undefined =>
	edgesFromIn(graph, t.id, "part_of")[0] ?? edgesFromIn(graph, t.id, "realizes")[0];

/**
 * Group tasks into lanes for the given grouping. Status mode returns the three
 * fixed columns (open/taken/done) with a `status` that drives move-targets;
 * every other mode returns alphabetically-sorted swimlanes.
 */
export function computeLanes(
	tasks: TaskMeta[],
	graph: GraphPayload,
	groupBy: GroupBy,
): Lane[] {
	if (groupBy === "status") {
		return STATUSES.map((s) => ({
			id: s,
			label: s,
			status: s,
			tasks: tasks.filter((t) => statusOf(t) === s),
		}));
	}
	const key = (t: TaskMeta): { id: string; label: string } => {
		if (groupBy === "priority") return { id: priorityOf(t), label: priorityOf(t) };
		if (groupBy === "takenBy")
			return { id: t.takenBy ?? "unassigned", label: t.takenBy ?? "unassigned" };
		if (groupBy === "epic") {
			const epic = nearestEpicOf(graph, t.id);
			return epic
				? { id: epic, label: titleForIn(graph, epic) }
				: { id: NO_EPIC, label: NO_EPIC_LABEL };
		}
		const domain = conceptOf(graph, t);
		return domain
			? { id: domain, label: titleForIn(graph, domain) }
			: { id: "_none", label: "unlinked" };
	};
	const map = new Map<string, Lane>();
	for (const t of tasks) {
		const { id, label } = key(t);
		let lane = map.get(id);
		if (!lane) map.set(id, (lane = { id, label, tasks: [] }));
		lane.tasks.push(t);
	}
	return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * "Lane miss" detector: true when the current task set references a concept id
 * (a task's part_of/realizes target) that has no matching node in the current
 * graph payload. That means the graph is stale relative to the tasks — a new or
 * renamed concept — so the board should refresh the graph now rather than wait
 * for the low-cadence tick. Tasks are themselves graph nodes, so this only
 * fires for genuinely-missing linked concepts.
 */
export function hasLaneMiss(tasks: TaskMeta[], graph: GraphPayload): boolean {
	const nodeIds = new Set(graph.nodes.map((n) => n.id));
	for (const t of tasks) {
		const domain = conceptOf(graph, t);
		if (domain && !nodeIds.has(domain)) return true;
	}
	return false;
}

// ------------------------------------------------------------------ epics
// "Epic" grouping (SPEC-CLOUD.md "Epics"): one swimlane per `epic` concept,
// each keeping the open/taken/done columns. A task belongs to its NEAREST
// epic: the fewest part_of/realizes hops out from the task, the same edges
// (and hop cap) burndown's scopeClosure walks inward, so a task under a
// feature that is part_of an epic counts toward that epic.

/** Lane id of the "No epic" swimlane (not a valid slug, so never an epic id). */
export const NO_EPIC = "_none";
export const NO_EPIC_LABEL = "No epic";

/** Ids of the real (non-pending) epic concepts in the graph. */
export function epicIdsIn(graph: GraphPayload): Set<string> {
	return new Set(graph.nodes.filter((n) => n.type === "epic" && !n.pending).map((n) => n.id));
}

/**
 * A concept's nearest epic: breadth-first over its outgoing part_of/realizes
 * edges (part_of before realizes, then edge order, at each hop), cycle-safe,
 * at most 6 hops (engine `nearestContainer`). Undefined when no epic is reachable.
 */
export function nearestEpicOf(
	graph: GraphPayload,
	id: string,
	epics: Set<string> = epicIdsIn(graph),
): string | undefined {
	if (epics.size === 0) return undefined;
	return nearestContainer(id, graph.edges, (to) => epics.has(to));
}

/** Progress roll-up for one epic lane. */
export interface EpicRollup {
	total: number;
	open: number;
	taken: number;
	done: number;
	/** done / total as a whole percent (0 when empty). */
	pct: number;
}

export function epicRollup(tasks: readonly TaskMeta[]): EpicRollup {
	const r = { total: tasks.length, open: 0, taken: 0, done: 0, pct: 0 };
	for (const t of tasks) r[statusOf(t)]++;
	r.pct = r.total === 0 ? 0 : Math.round((r.done / r.total) * 100);
	return r;
}

/** One epic swimlane: its tasks split into the three status columns. */
export interface EpicLane {
	/** The epic's concept id, or {@link NO_EPIC}. */
	id: string;
	label: string;
	columns: Record<Status, TaskMeta[]>;
	rollup: EpicRollup;
}

/**
 * Epic swimlanes: every epic in the graph (an empty one is still a drop
 * target), alphabetical by title, then "No epic" last when any task has none.
 */
export function computeEpicLanes(tasks: readonly TaskMeta[], graph: GraphPayload): EpicLane[] {
	const epics = epicIdsIn(graph);
	const byLane = new Map<string, TaskMeta[]>();
	for (const id of epics) byLane.set(id, []);
	const none: TaskMeta[] = [];
	for (const t of tasks) {
		const epic = nearestEpicOf(graph, t.id, epics);
		if (epic) byLane.get(epic)!.push(t);
		else none.push(t);
	}
	const lane = (id: string, label: string, list: TaskMeta[]): EpicLane => ({
		id,
		label,
		columns: {
			open: list.filter((t) => statusOf(t) === "open"),
			taken: list.filter((t) => statusOf(t) === "taken"),
			done: list.filter((t) => statusOf(t) === "done"),
		},
		rollup: epicRollup(list),
	});
	const lanes = [...byLane].map(([id, list]) => lane(id, titleForIn(graph, id), list));
	lanes.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
	if (none.length > 0) lanes.push(lane(NO_EPIC, NO_EPIC_LABEL, none));
	return lanes;
}

/**
 * The membership call that moves a task to another epic lane (null = it is
 * already there), or why the move is refused.
 */
export type EpicReparent =
	| { ok: true; call: { relation: "any"; target: string | null } | null }
	| { ok: false; reason: string };

/**
 * Plan a drag of `taskId` onto the `target` epic lane (null = "No epic").
 * The move is ONE atomic call (POST /concepts/:id/membership, relation "any",
 * type "epic"): the server drops every direct part_of/realizes epic link it
 * has STORED, links (part_of) the target, and refuses "No epic" with a 409
 * when an epic would still be inherited. This board-side check is the same
 * refusal from the cached graph, so the common case answers without a round
 * trip: dropping on "No epic" is refused while the task would still reach an
 * epic through another path (a feature it realizes, say), naming that epic.
 */
export function planEpicReparent(
	graph: GraphPayload,
	taskId: string,
	target: string | null,
	epics: Set<string> = epicIdsIn(graph),
): EpicReparent {
	const current = nearestEpicOf(graph, taskId, epics) ?? null;
	if (current === target) return { ok: true, call: null };
	if (target === null) {
		const remaining = nearestEpicOf(withEpicReparent(graph, taskId, null, epics), taskId, epics);
		if (remaining) {
			return {
				ok: false,
				reason: `This task is still in "${titleForIn(graph, remaining)}" through a parent concept; unlink that parent to remove it.`,
			};
		}
	}
	return { ok: true, call: { relation: "any", target } };
}

/**
 * The graph as it will look after a re-parent (the board's optimistic view
 * until the next graph refresh): the task's direct epic edges are dropped and
 * a part_of edge to the target added.
 */
export function withEpicReparent(
	graph: GraphPayload,
	taskId: string,
	target: string | null,
	epics: Set<string> = epicIdsIn(graph),
): GraphPayload {
	return {
		...graph,
		edges: [
			...graph.edges.filter(
				(e) =>
					!(
						e.from === taskId &&
						(e.relation === "part_of" || e.relation === "realizes") &&
						epics.has(e.to)
					),
			),
			...(target ? [{ from: taskId, to: target, relation: "part_of" }] : []),
		],
	};
}

/**
 * True when a task in the pile is not yet a node in the graph payload: its
 * edges (and so its epic) are unknown, so the epic board refreshes the graph
 * at once instead of parking the task under "No epic" for a whole cadence.
 */
export function hasTaskMiss(tasks: readonly TaskMeta[], graph: GraphPayload): boolean {
	const nodeIds = new Set(graph.nodes.map((n) => n.id));
	return tasks.some((t) => !nodeIds.has(t.id));
}

// Collapsed epic lanes are remembered per vault in localStorage (a per-viewer
// convenience). The stored value is a JSON array of lane ids.

export const collapsedStorageKey = (vaultId: string): string =>
	`brainz:board:epic-collapsed:${vaultId}`;

/** Parse a stored collapsed-lane list; anything malformed reads as none. */
export function parseCollapsed(raw: string | null | undefined): Set<string> {
	if (!raw) return new Set();
	try {
		const v: unknown = JSON.parse(raw);
		return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

/** Toggle one lane, returning a new set (the input is not mutated). */
export function toggleCollapsed(set: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(set);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

export const serializeCollapsed = (set: ReadonlySet<string>): string => JSON.stringify([...set].sort());

// ------------------------------------------------------------------ scope
// `?scope=<concept id>` narrows the board to one subtree (the feature tree's
// "Show on board"): the tasks in the concept's burndown closure.

/**
 * The tasks inside `scope`'s closure (part_of/realizes, transitively, as
 * burndown counts them). No scope returns the pile unchanged.
 */
export function scopeTasks(
	tasks: readonly TaskMeta[],
	graph: GraphPayload,
	scope: string | null | undefined,
): TaskMeta[] {
	if (!scope) return [...tasks];
	const members = scopeClosure(scope, graph.edges);
	return tasks.filter((t) => members.has(t.id));
}
