import { describe, expect, it } from "vitest";
import type { GraphPayload, TaskMeta } from "@brainz/contracts";
import { scopeClosure } from "@brainz/engine";
import {
	DEFAULT_LAYOUT,
	UNPLACED,
	ancestorsOf,
	boardHrefFor,
	buildFeatureTree,
	clip,
	cullLayout,
	defaultExpanded,
	expandableIds,
	layoutTree,
	linkPath,
	stateOf,
	treeRollup,
} from "./feature-tree";

const node = (id: string, type: string, extra: Partial<GraphPayload["nodes"][number]> = {}) => ({
	id,
	title: extra.title ?? id,
	type,
	tags: [],
	degree: 0,
	...extra,
});
const edge = (from: string, to: string, relation = "part_of") => ({ from, to, relation });
const task = (id: string, taskStatus: "open" | "taken" | "done" = "open", extra: Partial<TaskMeta> = {}): TaskMeta =>
	({ id, title: id, type: "task", status: "active", tags: [], taskStatus, ...extra }) as TaskMeta;

/** auth (domain) → checkout (epic) → pay (feature) → t1, t2; auth → t3 */
function sample(): { graph: GraphPayload; tasks: TaskMeta[] } {
	const graph: GraphPayload = {
		nodes: [
			node("auth", "domain", { title: "Auth" }),
			node("checkout", "epic", { title: "Checkout" }),
			node("pay", "feature", { title: "Pay button" }),
			node("t1", "task"),
			node("t2", "task"),
			node("t3", "task"),
			node("glossary-x", "glossary"),
		],
		edges: [
			edge("checkout", "auth"),
			edge("pay", "checkout"),
			edge("t1", "pay", "realizes"),
			edge("t2", "pay", "realizes"),
			edge("t3", "auth"),
			edge("glossary-x", "auth"),
		],
	};
	return { graph, tasks: [task("t1", "done"), task("t2", "taken", { takenBy: "agent-a" }), task("t3")] };
}

describe("buildFeatureTree", () => {
	it("builds domain → epic → feature → task from part_of/realizes", () => {
		const { graph, tasks } = sample();
		const tree = buildFeatureTree(graph, tasks);
		expect(tree.roots).toEqual(["auth"]);
		// Children sort by type rank (epic before task), then title.
		expect(tree.nodes.get("auth")!.children).toEqual(["checkout", "t3"]);
		expect(tree.nodes.get("checkout")!.children).toEqual(["pay"]);
		expect(tree.nodes.get("pay")!.children).toEqual(["t1", "t2"]);
		expect(tree.nodes.get("t1")!.depth).toBe(3);
		// Non-tree types (glossary) are left out.
		expect(tree.nodes.has("glossary-x")).toBe(false);
	});

	it("rolls tasks up through the scope closure and colours by state", () => {
		const { graph, tasks } = sample();
		const tree = buildFeatureTree(graph, tasks);
		const auth = tree.nodes.get("auth")!;
		expect(auth.rollup).toMatchObject({ total: 3, done: 1, taken: 1, open: 1, blocked: 0, pct: 33 });
		expect(auth.state).toBe("in-progress");
		expect(tree.nodes.get("pay")!.rollup).toMatchObject({ total: 2, done: 1, taken: 1 });
		expect(tree.nodes.get("t1")!.state).toBe("done");
		expect(tree.nodes.get("t2")!.task).toEqual({ status: "taken", takenBy: "agent-a", blocked: false });
		expect(tree.nodes.get("t3")!.state).toBe("not-started");
		// The same members burndown counts for the scope.
		const closureTasks = [...scopeClosure("auth", graph.edges)].filter((id) => id.startsWith("t"));
		expect(auth.rollup.total).toBe(closureTasks.length);
	});

	it("shows a multi-parent node once, under its first part_of, with the rest as other parents", () => {
		const { graph, tasks } = sample();
		graph.nodes.push(node("billing", "domain", { title: "Billing" }));
		// t1 realizes pay but is part_of billing: part_of wins as the primary parent.
		graph.edges.push(edge("t1", "billing"));
		const tree = buildFeatureTree(graph, tasks);
		expect(tree.nodes.get("t1")!.parent).toBe("billing");
		expect(tree.nodes.get("t1")!.otherParents).toEqual(["pay"]);
		expect(tree.nodes.get("pay")!.children).toEqual(["t2"]);
		expect(tree.nodes.get("billing")!.children).toEqual(["t1"]);
		// Roll-ups follow the closure, so both parents still count t1.
		expect(tree.nodes.get("pay")!.rollup.total).toBe(2);
		expect(tree.nodes.get("billing")!.rollup.total).toBe(1);
		// Every node appears exactly once across all children lists.
		const placed = [...tree.nodes.values()].flatMap((n) => n.children);
		expect(new Set(placed).size).toBe(placed.length);
	});

	it("breaks membership cycles without losing or duplicating nodes", () => {
		const graph: GraphPayload = {
			nodes: [node("a", "feature"), node("b", "feature"), node("c", "feature"), node("t", "task")],
			edges: [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("t", "a")],
		};
		const tree = buildFeatureTree(graph, [task("t", "done")]);
		// Placed in id order: a → b, b → c, then c → a would close the loop.
		expect(tree.nodes.get("a")!.parent).toBe("b");
		expect(tree.nodes.get("b")!.parent).toBe("c");
		expect(tree.nodes.get("c")!.parent).toBe(UNPLACED);
		expect(tree.nodes.get("c")!.otherParents).toEqual(["a"]);
		expect(tree.roots).toEqual([UNPLACED]);
		const placed = [...tree.nodes.values()].flatMap((n) => n.children);
		expect(placed.sort()).toEqual(["a", "b", "c", "t"]);
		// The closure is cycle-safe: every member of the cycle counts the task.
		for (const id of ["a", "b", "c"]) expect(tree.nodes.get(id)!.rollup.total).toBe(1);
		expect(tree.nodes.get(UNPLACED)!.rollup).toMatchObject({ total: 1, done: 1 });
		expect(tree.nodes.get(UNPLACED)!.state).toBe("done");
	});

	it("puts orphan features and tasks under Unplaced, last; domains and epics are roots", () => {
		const graph: GraphPayload = {
			nodes: [
				node("zeta", "domain"),
				node("alpha-epic", "epic"),
				node("lonely-feature", "feature"),
				node("lonely-task", "task"),
				node("ghost", "pending", { pending: true }),
			],
			edges: [edge("lonely-task", "ghost")],
		};
		const tree = buildFeatureTree(graph, [task("lonely-task"), task("brand-new")]);
		expect(tree.roots).toEqual(["zeta", "alpha-epic", UNPLACED]);
		// brand-new isn't in the graph yet; it still shows, under Unplaced.
		expect(tree.nodes.get(UNPLACED)!.children).toEqual(["lonely-feature", "brand-new", "lonely-task"]);
		expect(tree.nodes.get(UNPLACED)!.rollup.total).toBe(2);
		expect(tree.nodes.get("zeta")!.state).toBe("empty");
	});

	it("omits Unplaced when everything has a home", () => {
		const { graph, tasks } = sample();
		expect(buildFeatureTree(graph, tasks).nodes.has(UNPLACED)).toBe(false);
	});

	it("marks needs-* tasks (and what contains them) blocked", () => {
		const { graph, tasks } = sample();
		tasks[2] = task("t3", "open", { tags: ["needs-james"] });
		const tree = buildFeatureTree(graph, tasks);
		expect(tree.nodes.get("t3")!.state).toBe("blocked");
		expect(tree.nodes.get("auth")!.state).toBe("blocked");
		expect(tree.nodes.get("auth")!.rollup.blocked).toBe(1);
		// The feature without the blocked task is unaffected.
		expect(tree.nodes.get("pay")!.state).toBe("in-progress");
	});
});

/** Every node's roll-up total equals the tasks in engine scopeClosure for it. */
function expectClosureRollups(graph: GraphPayload, tasks: TaskMeta[]) {
	const tree = buildFeatureTree(graph, tasks);
	const taskIds = new Set([...tasks.map((t) => t.id), ...graph.nodes.filter((n) => n.type === "task").map((n) => n.id)]);
	for (const n of tree.nodes.values()) {
		if (n.id === UNPLACED) continue;
		const expected = [...scopeClosure(n.id, graph.edges)].filter((id) => taskIds.has(id)).length;
		expect(n.rollup.total, n.id).toBe(expected);
	}
}

describe("roll-ups match engine scopeClosure", () => {
	it("on the sample, multi-parent and cyclic graphs", () => {
		const { graph, tasks } = sample();
		expectClosureRollups(graph, tasks);
		graph.nodes.push(node("billing", "domain"));
		graph.edges.push(edge("t1", "billing"), edge("billing", "pay", "realizes"));
		expectClosureRollups(graph, tasks);
		expectClosureRollups(
			{
				nodes: [node("a", "feature"), node("b", "feature"), node("c", "epic"), node("t", "task"), node("u", "task")],
				edges: [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("t", "a"), edge("u", "t")],
			},
			[task("t"), task("u", "done")],
		);
	});
	it("respects the 6-hop cap on a long chain", () => {
		const n = 10;
		const graph: GraphPayload = {
			nodes: [node("t", "task"), ...Array.from({ length: n }, (_, i) => node(`f${i}`, "feature"))],
			edges: [edge("t", "f0"), ...Array.from({ length: n - 1 }, (_, i) => edge(`f${i}`, `f${i + 1}`))],
		};
		expectClosureRollups(graph, [task("t")]);
		const tree = buildFeatureTree(graph, [task("t")]);
		expect(tree.nodes.get("f5")!.rollup.total).toBe(1);
		expect(tree.nodes.get("f6")!.rollup.total).toBe(0);
	});
});

describe("stateOf / treeRollup", () => {
	it("derives each state", () => {
		expect(stateOf(treeRollup([]))).toBe("empty");
		expect(stateOf(treeRollup([task("a")]))).toBe("not-started");
		expect(stateOf(treeRollup([task("a", "taken")]))).toBe("in-progress");
		expect(stateOf(treeRollup([task("a", "done"), task("b")]))).toBe("in-progress");
		expect(stateOf(treeRollup([task("a", "done")]))).toBe("done");
		expect(stateOf(treeRollup([task("a", "done", { tags: ["needs-x"] })]))).toBe("done");
		expect(stateOf(treeRollup([task("a")]), ["needs-design"])).toBe("blocked");
		expect(stateOf(treeRollup([task("a", "done")]), ["needs-design"])).toBe("done");
	});
});

describe("expansion", () => {
	it("opens the top levels by default and everything on expand all", () => {
		const { graph, tasks } = sample();
		const tree = buildFeatureTree(graph, tasks);
		expect([...defaultExpanded(tree)].sort()).toEqual(["auth", "checkout"]);
		expect([...expandableIds(tree)].sort()).toEqual(["auth", "checkout", "pay"]);
		expect(ancestorsOf(tree, "t1")).toEqual(["auth", "checkout", "pay"]);
	});
});

describe("layoutTree", () => {
	it("places only expanded subtrees, parents centred over their children", () => {
		const { graph, tasks } = sample();
		const tree = buildFeatureTree(graph, tasks);
		const layout = layoutTree(tree, new Set(["auth", "checkout", "pay"]));
		const at = new Map(layout.nodes.map((n) => [n.id, n]));
		expect(layout.nodes).toHaveLength(6);
		const { nodeW, gapBreadth, nodeH, gapDepth } = DEFAULT_LAYOUT;
		// Leaves t1, t2, t3 take slots 0, 1, 2 along x.
		expect(at.get("t1")!.x).toBe((nodeW + gapBreadth) / 2);
		expect(at.get("t3")!.x - at.get("t2")!.x).toBe(nodeW + gapBreadth);
		expect(at.get("pay")!.x).toBe((at.get("t1")!.x + at.get("t2")!.x) / 2);
		expect(at.get("auth")!.x).toBe((at.get("checkout")!.x + at.get("t3")!.x) / 2);
		expect(at.get("t1")!.y - at.get("pay")!.y).toBe(nodeH + gapDepth);
		expect(layout.links).toContainEqual({ from: "pay", to: "t1" });

		const collapsed = layoutTree(tree, new Set(["auth"]));
		expect(collapsed.nodes.map((n) => n.id).sort()).toEqual(["auth", "checkout", "t3"]);
	});

	it("swaps the axes left-right", () => {
		const { graph, tasks } = sample();
		const tree = buildFeatureTree(graph, tasks);
		const all = expandableIds(tree);
		const tb = layoutTree(tree, all);
		const lr = layoutTree(tree, all, { ...DEFAULT_LAYOUT, orientation: "lr" });
		expect(lr.nodes.find((n) => n.id === "t1")!.x).toBeGreaterThan(lr.nodes.find((n) => n.id === "auth")!.x);
		expect(tb.width).toBeGreaterThan(tb.height);
		expect(lr.width).toBe(4 * (DEFAULT_LAYOUT.nodeW + DEFAULT_LAYOUT.gapDepth));
		expect(lr.height).toBe(3 * (DEFAULT_LAYOUT.nodeH + DEFAULT_LAYOUT.gapBreadth));
	});

	it("handles a very deep chain iteratively", () => {
		const n = 5000;
		const graph: GraphPayload = {
			nodes: [node("root", "domain"), ...Array.from({ length: n }, (_, i) => node(`f${i}`, "feature"))],
			edges: Array.from({ length: n }, (_, i) => edge(`f${i}`, i === 0 ? "root" : `f${i - 1}`)),
		};
		const tree = buildFeatureTree(graph, []);
		expect(tree.nodes.get(`f${n - 1}`)!.depth).toBe(n);
		expect(layoutTree(tree, expandableIds(tree)).nodes).toHaveLength(n + 1);
	});
});

describe("cullLayout", () => {
	it("keeps only nodes and links that meet the viewport", () => {
		const { graph, tasks } = sample();
		const tree = buildFeatureTree(graph, tasks);
		const layout = layoutTree(tree, expandableIds(tree));
		const t1 = layout.nodes.find((n) => n.id === "t1")!;
		const view = { x: t1.x - 10, y: t1.y - 10, w: 20, h: 20 };
		const culled = cullLayout(layout, view);
		expect(culled.nodes.map((n) => n.id)).toEqual(["t1"]);
		expect(culled.links.map((l) => `${l.from.id}>${l.to.id}`)).toContain("pay>t1");
		expect(cullLayout(layout, { x: -1e6, y: -1e6, w: 10, h: 10 }).nodes).toEqual([]);
	});
});

describe("helpers", () => {
	it("draws elbow links for both orientations", () => {
		expect(linkPath({ x: 100, y: 50 }, { x: 300, y: 200 })).toBe(
			`M100,${50 + DEFAULT_LAYOUT.nodeH / 2}V${(50 + DEFAULT_LAYOUT.nodeH / 2 + 200 - DEFAULT_LAYOUT.nodeH / 2) / 2}H300V${200 - DEFAULT_LAYOUT.nodeH / 2}`,
		);
		expect(linkPath({ x: 0, y: 0 }, { x: 400, y: 80 }, { ...DEFAULT_LAYOUT, orientation: "lr" })).toMatch(/^M105,0H/);
	});
	it("clips titles and builds the board link", () => {
		expect(clip("short", 10)).toBe("short");
		expect(clip("a long concept title", 8)).toBe("a long …");
		expect(boardHrefFor("acme", "pay button")).toBe("/v/acme/board?group=epic&scope=pay%20button");
	});
});
