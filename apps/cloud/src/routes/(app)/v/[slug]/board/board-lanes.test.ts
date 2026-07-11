import { describe, expect, it } from "vitest";
import type { GraphPayload, TaskMeta } from "@brainz/contracts";
import { computeLanes, conceptOf, hasLaneMiss, priorityOf, statusOf } from "./board-lanes";

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
