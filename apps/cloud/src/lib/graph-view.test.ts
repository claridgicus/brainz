import { describe, expect, it } from "vitest";
import type { Edge } from "@brainz/contracts";
import {
	anchorStorageKey,
	applyAnchors,
	clearAnchorsFromNodes,
	defaultVisibleTypes,
	deserializeAnchors,
	isNodeInViewport,
	nodesInViewport,
	planEdges,
	serializeAnchors,
	setAnchor,
	stubEdgesFor,
	toScreen,
	type AnchorableNode,
	type AnchorMap,
	type PositionedNode,
	type ViewTransform,
} from "./graph-view";

const rect = { width: 100, height: 100 };
const identity: ViewTransform = { x: 0, y: 0, k: 1 };

const node = (id: string, x: number, y: number, r = 5): PositionedNode => ({ id, x, y, r });

describe("defaultVisibleTypes", () => {
	it("is the ~5 high-signal structural types, all valid palette types", () => {
		const def = defaultVisibleTypes();
		expect(def).toEqual(["domain", "feature", "spec", "story", "task"]);
		// concept/decision/etc are hidden by default
		expect(def).not.toContain("concept");
		expect(def).not.toContain("glossary");
	});
	it("returns a fresh array each call (no shared mutation)", () => {
		const a = defaultVisibleTypes();
		a.push("mutated");
		expect(defaultVisibleTypes()).not.toContain("mutated");
	});
});

describe("toScreen", () => {
	it("applies scale then translate", () => {
		expect(toScreen(node("a", 10, 20), { x: 5, y: 5, k: 2 })).toEqual({ x: 25, y: 45 });
	});
});

describe("isNodeInViewport", () => {
	it("includes a node centred inside the rect", () => {
		expect(isNodeInViewport(node("a", 50, 50), identity, rect)).toBe(true);
	});
	it("excludes a node fully off to the right", () => {
		expect(isNodeInViewport(node("a", 200, 50), identity, rect)).toBe(false);
	});
	it("boundary: a node whose radius just overlaps the left edge is IN", () => {
		// centre at x=-4, r=5 → right edge at x=1 ≥ 0 → in view
		expect(isNodeInViewport(node("a", -4, 50, 5), identity, rect)).toBe(true);
	});
	it("boundary: a node whose radius just misses the left edge is OUT", () => {
		// centre at x=-6, r=5 → right edge at x=-1 < 0 → out
		expect(isNodeInViewport(node("a", -6, 50, 5), identity, rect)).toBe(false);
	});
	it("respects pan/zoom transform", () => {
		// graph (100,100) with k=0.5, no pan → screen (50,50): in view
		expect(isNodeInViewport(node("a", 100, 100), { x: 0, y: 0, k: 0.5 }, rect)).toBe(true);
		// pan the view left by 80 → screen (-30,50): mostly out (r=5 → 25 < 0)
		expect(isNodeInViewport(node("a", 100, 100), { x: -80, y: 0, k: 0.5 }, rect)).toBe(false);
	});
	it("margin keeps just-off-screen nodes in", () => {
		expect(isNodeInViewport(node("a", 130, 50), identity, rect, 0)).toBe(false);
		expect(isNodeInViewport(node("a", 130, 50), identity, rect, 40)).toBe(true);
	});
});

describe("nodesInViewport", () => {
	it("returns only the in-view ids", () => {
		const nodes = [node("in", 50, 50), node("out", 500, 500), node("edge", -4, 50)];
		expect([...nodesInViewport(nodes, identity, rect)].sort()).toEqual(["edge", "in"]);
	});
});

describe("planEdges / stubEdgesFor", () => {
	const edges: Edge[] = [
		{ from: "a", to: "b", relation: "references" }, // both visible → full
		{ from: "b", to: "c", relation: "depends_on" }, // b visible, c off → stub
		{ from: "c", to: "d", relation: "references" }, // both off → dropped
		{ from: "a", to: "gone", relation: "references" }, // endpoint filtered out → dropped
	];
	const allIds = new Set(["a", "b", "c", "d"]);
	const visible = new Set(["a", "b"]);

	it("marks both-visible edges full, mixed edges stub, both-off dropped", () => {
		const plans = planEdges(edges, visible, allIds);
		expect(plans).toHaveLength(2);
		const [full, stub] = plans;
		expect(full).toMatchObject({ full: true, stub: false });
		expect(full!.edge.to).toBe("b");
		expect(stub).toMatchObject({ full: false, stub: true, anchorId: "b", towardId: "c" });
	});

	it("anchors the stub at whichever endpoint is on-screen (to-side)", () => {
		// edge from off-screen z to visible a: anchor should be a, toward z
		const e: Edge[] = [{ from: "z", to: "a", relation: "references" }];
		const plans = planEdges(e, new Set(["a"]), new Set(["a", "z"]));
		expect(plans[0]).toMatchObject({ stub: true, anchorId: "a", towardId: "z" });
	});

	it("drops edges whose endpoint was type-filtered out of allIds", () => {
		// the a→gone edge references a node not in allIds
		const plans = planEdges(edges, visible, allIds);
		expect(plans.some((p) => p.edge.to === "gone")).toBe(false);
	});

	it("stubEdgesFor returns only the stub plans", () => {
		const stubs = stubEdgesFor(edges, visible, allIds);
		expect(stubs).toHaveLength(1);
		expect(stubs[0]!.towardId).toBe("c");
	});
});

describe("anchorStorageKey", () => {
	it("namespaces the key per vault", () => {
		expect(anchorStorageKey("v1")).toBe("brainz:graph:anchors:v1");
		expect(anchorStorageKey("v2")).not.toBe(anchorStorageKey("v1"));
	});
});

describe("anchors serialize/deserialize round-trip", () => {
	it("round-trips a map through storage form", () => {
		const anchors: AnchorMap = { a: { x: 10, y: 20 }, b: { x: -3.5, y: 99 } };
		expect(deserializeAnchors(serializeAnchors(anchors))).toEqual(anchors);
	});

	it("returns empty for null/empty/whitespace", () => {
		expect(deserializeAnchors(null)).toEqual({});
		expect(deserializeAnchors(undefined)).toEqual({});
		expect(deserializeAnchors("")).toEqual({});
	});

	it("returns empty for non-JSON garbage without throwing", () => {
		expect(deserializeAnchors("{not json")).toEqual({});
		expect(deserializeAnchors("42")).toEqual({});
		expect(deserializeAnchors("[1,2,3]")).toEqual({});
	});

	it("drops entries with missing / non-finite / wrong-typed coords", () => {
		const raw = JSON.stringify({
			ok: { x: 1, y: 2 },
			noY: { x: 1 },
			stringX: { x: "5", y: 2 },
			nan: { x: Number.NaN, y: 2 }, // serializes to null → dropped
			nullVal: null,
			numVal: 7,
		});
		expect(deserializeAnchors(raw)).toEqual({ ok: { x: 1, y: 2 } });
	});
});

describe("setAnchor", () => {
	it("adds a new anchor without mutating the input", () => {
		const before: AnchorMap = { a: { x: 1, y: 1 } };
		const after = setAnchor(before, "b", { x: 2, y: 3 });
		expect(after).toEqual({ a: { x: 1, y: 1 }, b: { x: 2, y: 3 } });
		expect(before).toEqual({ a: { x: 1, y: 1 } }); // unchanged
	});

	it("overwrites an existing anchor (drag an already-pinned node)", () => {
		const after = setAnchor({ a: { x: 1, y: 1 } }, "a", { x: 9, y: 9 });
		expect(after).toEqual({ a: { x: 9, y: 9 } });
	});
});

describe("applyAnchors", () => {
	const nodes = (): AnchorableNode[] => [
		{ id: "a", x: 0, y: 0 },
		{ id: "b", x: 0, y: 0 },
		{ id: "c", x: 0, y: 0 },
	];

	it("pins anchored nodes (fx/fy + seeds x/y) and leaves others free", () => {
		const ns = nodes();
		const applied = applyAnchors(ns, { a: { x: 11, y: 22 }, c: { x: 5, y: 6 } });
		expect([...applied].sort()).toEqual(["a", "c"]);
		expect(ns[0]).toMatchObject({ fx: 11, fy: 22, x: 11, y: 22 });
		expect(ns[2]).toMatchObject({ fx: 5, fy: 6, x: 5, y: 6 });
		// b had no anchor → fx/fy untouched (undefined), free to lay out.
		expect(ns[1]!.fx).toBeUndefined();
		expect(ns[1]!.fy).toBeUndefined();
	});

	it("ignores anchors for ids not in the node set", () => {
		const ns = nodes();
		const applied = applyAnchors(ns, { ghost: { x: 1, y: 1 } });
		expect(applied.size).toBe(0);
		expect(ns.every((n) => n.fx == null && n.fy == null)).toBe(true);
	});
});

describe("clearAnchorsFromNodes", () => {
	it("un-pins every node so a fresh layout can run", () => {
		const ns: AnchorableNode[] = [
			{ id: "a", fx: 1, fy: 2 },
			{ id: "b", fx: 3, fy: 4 },
		];
		clearAnchorsFromNodes(ns);
		expect(ns.every((n) => n.fx === null && n.fy === null)).toBe(true);
	});
});
