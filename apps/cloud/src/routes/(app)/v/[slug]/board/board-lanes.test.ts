import { describe, expect, it } from "vitest";
import type { GraphPayload, TaskMeta } from "@brainz/contracts";
import {
	NO_EPIC,
	collapsedStorageKey,
	computeEpicLanes,
	computeLanes,
	conceptOf,
	epicRollup,
	hasLaneMiss,
	hasTaskMiss,
	nearestEpicOf,
	parseCollapsed,
	planEpicReparent,
	priorityOf,
	scopeTasks,
	serializeCollapsed,
	statusOf,
	toggleCollapsed,
	withEpicReparent,
} from "./board-lanes";

const task = (over: Partial<TaskMeta> & { id: string; title: string }): TaskMeta => ({
	type: "task",
	status: "active",
	tags: [],
	codeAreas: [],
	...over,
});

// A graph where task-a is part_of the "board" concept (titled "Kanban board").
const graph: GraphPayload = {
	nodes: [
		{ id: "board", title: "Kanban board", type: "domain", tags: [], degree: 2 },
		{ id: "task-a", title: "Ship it", type: "task", tags: [], degree: 1 },
		{ id: "task-b", title: "Fix it", type: "task", tags: [], degree: 1 },
	],
	edges: [{ from: "task-a", to: "board", relation: "part_of" }],
};

describe("statusOf / priorityOf", () => {
	it("treats a null taskStatus as open", () => {
		expect(statusOf(task({ id: "task-a", title: "Ship it" }))).toBe("open");
		expect(statusOf(task({ id: "task-a", title: "Ship it", taskStatus: "done" }))).toBe("done");
	});
	it("reads priority from tags, case-insensitively, else unprioritized", () => {
		expect(priorityOf(task({ id: "x", title: "x", tags: ["High"] }))).toBe("High");
		expect(priorityOf(task({ id: "x", title: "x", tags: ["area-board"] }))).toBe("unprioritized");
	});
});

describe("computeLanes", () => {
	it("status mode returns the three fixed columns in order", () => {
		const tasks = [
			task({ id: "task-a", title: "Ship it", taskStatus: "open" }),
			task({ id: "task-b", title: "Fix it", taskStatus: "done" }),
		];
		const lanes = computeLanes(tasks, graph, "status");
		expect(lanes.map((l) => l.id)).toEqual(["open", "taken", "done"]);
		expect(lanes[0].tasks.map((t) => t.id)).toEqual(["task-a"]);
		expect(lanes[2].tasks.map((t) => t.id)).toEqual(["task-b"]);
	});

	it("concept mode labels a lane with the concept title from the graph", () => {
		const tasks = [task({ id: "task-a", title: "Ship it" })];
		const lanes = computeLanes(tasks, graph, "concept");
		expect(lanes).toHaveLength(1);
		expect(lanes[0].id).toBe("board");
		expect(lanes[0].label).toBe("Kanban board");
	});

	it("concept lane label follows a renamed concept in a refreshed graph", () => {
		const tasks = [task({ id: "task-a", title: "Ship it" })];
		const renamed: GraphPayload = {
			...graph,
			nodes: graph.nodes.map((n) => (n.id === "board" ? { ...n, title: "Renamed board" } : n)),
		};
		expect(computeLanes(tasks, renamed, "concept")[0].label).toBe("Renamed board");
	});

	it("unlinked tasks fall into an 'unlinked' lane", () => {
		const tasks = [task({ id: "task-b", title: "Fix it" })];
		const lanes = computeLanes(tasks, graph, "concept");
		expect(lanes[0].id).toBe("_none");
		expect(lanes[0].label).toBe("unlinked");
	});
});

describe("conceptOf", () => {
	it("prefers part_of over realizes", () => {
		const g: GraphPayload = {
			nodes: graph.nodes,
			edges: [
				{ from: "task-a", to: "story-x", relation: "realizes" },
				{ from: "task-a", to: "board", relation: "part_of" },
			],
		};
		expect(conceptOf(g, task({ id: "task-a", title: "Ship it" }))).toBe("board");
	});
});

describe("hasLaneMiss", () => {
	it("is false when every linked concept is present in the graph", () => {
		const tasks = [task({ id: "task-a", title: "Ship it" })];
		expect(hasLaneMiss(tasks, graph)).toBe(false);
	});

	it("is true when a task links to a concept absent from the graph (stale graph)", () => {
		// task-a now part_of "new-concept" which the graph doesn't have yet.
		const staleGraph: GraphPayload = {
			nodes: graph.nodes,
			edges: [{ from: "task-a", to: "new-concept", relation: "part_of" }],
		};
		const tasks = [task({ id: "task-a", title: "Ship it" })];
		expect(hasLaneMiss(tasks, staleGraph)).toBe(true);
	});

	it("is false for unlinked tasks (no concept referenced)", () => {
		const tasks = [task({ id: "task-b", title: "Fix it" })];
		expect(hasLaneMiss(tasks, graph)).toBe(false);
	});
});

// ------------------------------------------------------------------ epics

// checkout (epic) ← pay-button (feature, part_of) ← t-feature (realizes)
// checkout ← t-direct (part_of)   platform (epic) ← t-platform (part_of)
// t-loose has only a domain; t-two is part_of BOTH a feature of checkout and platform.
const epicGraph: GraphPayload = {
	nodes: [
		{ id: "checkout", title: "Checkout v2", type: "epic", tags: [], degree: 3 },
		{ id: "platform", title: "Platform", type: "epic", tags: [], degree: 2 },
		{ id: "empty-epic", title: "Archive", type: "epic", tags: [], degree: 0 },
		{ id: "ghost", title: "ghost", type: "epic", tags: [], degree: 1, pending: true },
		{ id: "pay-button", title: "Pay button", type: "feature", tags: [], degree: 2 },
		{ id: "board", title: "Kanban board", type: "domain", tags: [], degree: 1 },
		...["t-feature", "t-direct", "t-platform", "t-loose", "t-two", "t-real"].map((id) => ({
			id,
			title: id,
			type: "task",
			tags: [],
			degree: 1,
		})),
	],
	edges: [
		{ from: "pay-button", to: "checkout", relation: "part_of" },
		{ from: "t-feature", to: "pay-button", relation: "realizes" },
		{ from: "t-direct", to: "checkout", relation: "part_of" },
		{ from: "t-platform", to: "platform", relation: "part_of" },
		{ from: "t-loose", to: "board", relation: "part_of" },
		{ from: "t-loose", to: "ghost", relation: "part_of" },
		{ from: "t-two", to: "pay-button", relation: "part_of" },
		{ from: "t-two", to: "platform", relation: "part_of" },
		{ from: "t-real", to: "checkout", relation: "realizes" },
	],
};

describe("nearestEpicOf", () => {
	it("follows part_of/realizes out to the nearest epic, through features", () => {
		expect(nearestEpicOf(epicGraph, "t-direct")).toBe("checkout");
		expect(nearestEpicOf(epicGraph, "t-feature")).toBe("checkout");
		expect(nearestEpicOf(epicGraph, "t-real")).toBe("checkout");
		expect(nearestEpicOf(epicGraph, "t-platform")).toBe("platform");
	});
	it("prefers the fewest hops: a direct epic beats one via a feature", () => {
		expect(nearestEpicOf(epicGraph, "t-two")).toBe("platform");
	});
	it("ignores pending epics and returns undefined with no epic", () => {
		expect(nearestEpicOf(epicGraph, "t-loose")).toBeUndefined();
	});
	it("survives cycles and stops at the hop cap", () => {
		const cyc: GraphPayload = {
			nodes: [{ id: "e", title: "E", type: "epic", tags: [], degree: 1 }],
			edges: [
				{ from: "t", to: "a", relation: "part_of" },
				{ from: "a", to: "b", relation: "part_of" },
				{ from: "b", to: "a", relation: "part_of" },
			],
		};
		expect(nearestEpicOf(cyc, "t")).toBeUndefined();
		const chain = (n: number): GraphPayload => ({
			nodes: [{ id: "e", title: "E", type: "epic", tags: [], degree: 1 }],
			edges: Array.from({ length: n }, (_, i) => ({
				from: i === 0 ? "t" : `c${i}`,
				to: i === n - 1 ? "e" : `c${i + 1}`,
				relation: "part_of",
			})),
		});
		expect(nearestEpicOf(chain(6), "t")).toBe("e");
		expect(nearestEpicOf(chain(7), "t")).toBeUndefined();
	});
});

describe("computeEpicLanes", () => {
	const tasks = [
		task({ id: "t-feature", title: "F", taskStatus: "done" }),
		task({ id: "t-direct", title: "D", taskStatus: "taken", takenBy: "w" }),
		task({ id: "t-real", title: "R" }),
		task({ id: "t-platform", title: "P", taskStatus: "done" }),
		task({ id: "t-loose", title: "L" }),
	];
	const lanes = computeEpicLanes(tasks, epicGraph);

	it("one lane per real epic (empty ones too), alphabetical, No epic last", () => {
		expect(lanes.map((l) => l.id)).toEqual(["empty-epic", "checkout", "platform", NO_EPIC]);
		expect(lanes.map((l) => l.label)).toEqual(["Archive", "Checkout v2", "Platform", "No epic"]);
	});
	it("keeps open/taken/done columns inside each lane", () => {
		const checkout = lanes.find((l) => l.id === "checkout")!;
		expect(checkout.columns.open.map((t) => t.id)).toEqual(["t-real"]);
		expect(checkout.columns.taken.map((t) => t.id)).toEqual(["t-direct"]);
		expect(checkout.columns.done.map((t) => t.id)).toEqual(["t-feature"]);
	});
	it("rolls up done/total and the taken count per lane", () => {
		expect(lanes.find((l) => l.id === "checkout")!.rollup).toEqual({
			total: 3,
			open: 1,
			taken: 1,
			done: 1,
			pct: 33,
		});
		expect(lanes.find((l) => l.id === "empty-epic")!.rollup.pct).toBe(0);
		expect(lanes.find((l) => l.id === "platform")!.rollup.pct).toBe(100);
	});
	it("omits No epic when every task has one", () => {
		expect(computeEpicLanes(tasks.slice(0, 2), epicGraph).some((l) => l.id === NO_EPIC)).toBe(false);
	});
	it("computeLanes('epic') groups flat by nearest epic", () => {
		const flat = computeLanes(tasks, epicGraph, "epic");
		expect(flat.find((l) => l.id === "checkout")!.tasks).toHaveLength(3);
		expect(flat.find((l) => l.id === NO_EPIC)!.label).toBe("No epic");
	});
	it("epicRollup on an empty list is all zero", () => {
		expect(epicRollup([])).toEqual({ total: 0, open: 0, taken: 0, done: 0, pct: 0 });
	});
});

describe("planEpicReparent / withEpicReparent", () => {
	it("every move is one atomic relation-\"any\" call (the server clears stored epic links)", () => {
		expect(planEpicReparent(epicGraph, "t-direct", "platform")).toEqual({
			ok: true,
			call: { relation: "any", target: "platform" },
		});
		expect(planEpicReparent(epicGraph, "t-real", "platform")).toEqual({
			ok: true,
			call: { relation: "any", target: "platform" },
		});
		expect(planEpicReparent(epicGraph, "t-real", null)).toEqual({
			ok: true,
			call: { relation: "any", target: null },
		});
	});
	it("an inherited member can move to another epic but not to No epic", () => {
		expect(planEpicReparent(epicGraph, "t-feature", "platform")).toEqual({
			ok: true,
			call: { relation: "any", target: "platform" },
		});
		const refused = planEpicReparent(epicGraph, "t-feature", null);
		expect(refused.ok).toBe(false);
		expect(!refused.ok && refused.reason).toContain("Checkout v2");
	});
	it("refuses No epic for a mixed member: a direct epic plus one inherited through a feature", () => {
		// t-two is part_of Platform directly AND part_of a feature under Checkout v2.
		// Dropping the direct link would leave it in Checkout v2, not in No epic.
		expect(nearestEpicOf(epicGraph, "t-two")).toBe("platform");
		const refused = planEpicReparent(epicGraph, "t-two", null);
		expect(refused.ok).toBe(false);
		expect(!refused.ok && refused.reason).toContain("Checkout v2");
	});
	it("same lane is a no-op; No epic → epic links the target", () => {
		expect(planEpicReparent(epicGraph, "t-direct", "checkout")).toEqual({ ok: true, call: null });
		expect(planEpicReparent(epicGraph, "t-loose", "checkout")).toEqual({
			ok: true,
			call: { relation: "any", target: "checkout" },
		});
	});
	it("the optimistic graph puts the task in the target lane and keeps other links", () => {
		const g = withEpicReparent(epicGraph, "t-real", "platform");
		expect(nearestEpicOf(g, "t-real")).toBe("platform");
		const g2 = withEpicReparent(epicGraph, "t-loose", "checkout");
		expect(g2.edges.filter((e) => e.from === "t-loose").map((e) => e.to).sort()).toEqual([
			"board",
			"checkout",
			"ghost",
		]);
		expect(nearestEpicOf(withEpicReparent(epicGraph, "t-direct", null), "t-direct")).toBeUndefined();
	});
});

describe("hasTaskMiss / collapsed lanes", () => {
	it("flags a task the graph has not caught up with", () => {
		expect(hasTaskMiss([task({ id: "t-direct", title: "D" })], epicGraph)).toBe(false);
		expect(hasTaskMiss([task({ id: "brand-new", title: "N" })], epicGraph)).toBe(true);
	});
	it("round-trips the collapsed set and tolerates junk", () => {
		const set = toggleCollapsed(toggleCollapsed(new Set(), "checkout"), NO_EPIC);
		expect(parseCollapsed(serializeCollapsed(set))).toEqual(new Set(["checkout", NO_EPIC]));
		expect(toggleCollapsed(set, "checkout")).toEqual(new Set([NO_EPIC]));
		expect(set.has("checkout")).toBe(true); // not mutated
		expect(parseCollapsed("{nope")).toEqual(new Set());
		expect(parseCollapsed('[1,"a"]')).toEqual(new Set(["a"]));
		expect(parseCollapsed(null)).toEqual(new Set());
		expect(collapsedStorageKey("v1")).toBe("brainz:board:epic-collapsed:v1");
	});
});

describe("scopeTasks", () => {
	it("keeps the tasks in the scope's closure, or all without a scope", () => {
		const graph: GraphPayload = {
			nodes: [],
			edges: [
				{ from: "feat", to: "epic-a", relation: "part_of" },
				{ from: "t1", to: "feat", relation: "realizes" },
				{ from: "t2", to: "epic-a", relation: "part_of" },
				{ from: "t3", to: "other", relation: "part_of" },
			],
		};
		const pile = ["t1", "t2", "t3"].map(
			(id) => ({ id, title: id, type: "task", status: "active", tags: [] }) as unknown as TaskMeta,
		);
		expect(scopeTasks(pile, graph, "epic-a").map((t) => t.id)).toEqual(["t1", "t2"]);
		expect(scopeTasks(pile, graph, "feat").map((t) => t.id)).toEqual(["t1"]);
		expect(scopeTasks(pile, graph, null)).toHaveLength(3);
	});
});
