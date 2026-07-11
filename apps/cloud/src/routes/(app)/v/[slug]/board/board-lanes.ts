// Pure board grouping/lane logic — no Svelte, no DOM — so it can be unit-tested
// and reused by the +page.svelte component. Grouping is client-side (see
// spec-board-grouping-client): the tasks endpoint returns one flat list and the
// board derives lanes from the task set + the concept graph payload.
import type { GraphPayload, TaskMeta } from "@brainz/contracts";

export const STATUSES = ["open", "taken", "done"] as const;
export type Status = (typeof STATUSES)[number];
export type GroupBy = "status" | "concept" | "priority" | "takenBy";

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
