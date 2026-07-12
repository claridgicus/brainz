import { describe, expect, it } from "vitest";
import type { ConceptTypeEntry, Edge } from "@brainz/contracts";
import { BUILTIN_CONCEPT_TYPES } from "@brainz/contracts";
import {
	anchorStorageKey,
	applyAnchors,
	clearAnchorsFromNodes,
	defaultVisibleTypes,
	deserializeAnchors,
	effectiveVisibleTypes,
	filterModeStorageKey,
	focusRevealSet,
	isDimmed,
	isEdgeDimmed,
	isNodeInViewport,
	LOD_MAX_SCALE,
	LOD_MIN_SCALE,
	lodThresholdForRank,
	MAX_SIGNAL_RANK,
	mergeFocusRender,
	nodesInViewport,
	parseFilterMode,
	planEdges,
	radiusForTypeDegree,
	registryView,
	serializeAnchors,
	setAnchor,
	signalRank,
	sizeScaleForWeight,
	stubEdgesFor,
	toScreen,
	typeClusterCenter,
	typesVisibleAtZoom,
	typeSizeScale,
	type AnchorableNode,
	type AnchorMap,
	type PositionedNode,
	type ViewTransform,
} from "./graph-view";
import { ALL_TYPES } from "./graph-data";

/** Build the seed registry exactly as a fresh vault does (canonical order). */
function seedRegistry(): ConceptTypeEntry[] {
	return BUILTIN_CONCEPT_TYPES.map((t, i) => ({
		key: t.key,
		label: t.label,
		color: t.color,
		weight: t.weight,
		order: i,
		hidden: false,
		builtin: true,
	}));
}

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

describe("signalRank / lodThresholdForRank", () => {
	it("ranks domain highest (0), pending lowest (MAX)", () => {
		expect(signalRank("domain")).toBe(0);
		expect(signalRank("feature")).toBeLessThan(signalRank("story"));
		expect(signalRank("story")).toBeLessThan(signalRank("task"));
		expect(signalRank("pending")).toBe(MAX_SIGNAL_RANK);
	});
	it("treats unknown types as the lowest rank (revealed last, never never)", () => {
		expect(signalRank("totally-made-up")).toBe(MAX_SIGNAL_RANK);
	});
	it("maps rank 0 to min scale and max rank to max scale, monotonic between", () => {
		expect(lodThresholdForRank(0)).toBeCloseTo(LOD_MIN_SCALE);
		expect(lodThresholdForRank(MAX_SIGNAL_RANK)).toBeCloseTo(LOD_MAX_SCALE);
		expect(lodThresholdForRank(1)).toBeGreaterThan(lodThresholdForRank(0));
		expect(lodThresholdForRank(2)).toBeGreaterThan(lodThresholdForRank(1));
	});
	it("clamps out-of-range ranks", () => {
		expect(lodThresholdForRank(-5)).toBeCloseTo(LOD_MIN_SCALE);
		expect(lodThresholdForRank(999)).toBeCloseTo(LOD_MAX_SCALE);
	});
});

describe("typesVisibleAtZoom", () => {
	it("shows only domains at (and below) min zoom", () => {
		const atMin = typesVisibleAtZoom(LOD_MIN_SCALE);
		expect([...atMin]).toEqual(["domain"]);
		const wayOut = typesVisibleAtZoom(0.05);
		expect([...wayOut]).toEqual(["domain"]);
	});
	it("shows every type once zoomed in past max scale", () => {
		// At exactly LOD_MAX_SCALE the lowest rank sits on its threshold; a
		// decisive zoom past it (the wheel goes to 8) reveals everything.
		const atMax = typesVisibleAtZoom(LOD_MAX_SCALE * 1.2);
		expect([...atMax].sort()).toEqual([...ALL_TYPES].sort());
		const wayIn = typesVisibleAtZoom(8);
		expect([...wayIn].sort()).toEqual([...ALL_TYPES].sort());
	});
	it("reveals tiers progressively as scale grows (rank 0 ⊂ rank1 ⊂ ...)", () => {
		const t0 = typesVisibleAtZoom(LOD_MIN_SCALE);
		const t1 = typesVisibleAtZoom(lodThresholdForRank(1) * 1.2);
		const t2 = typesVisibleAtZoom(lodThresholdForRank(2) * 1.2);
		expect(t1.has("feature")).toBe(true);
		expect(t1.has("story")).toBe(false); // rank 2 not yet in at rank-1 scale
		expect(t2.has("story")).toBe(true);
		// each tier is a superset of the previous
		for (const t of t0) expect(t1.has(t)).toBe(true);
		for (const t of t1) expect(t2.has(t)).toBe(true);
	});
	it("is monotonic in scale — zooming in never removes a type", () => {
		let prev = new Set<string>();
		for (let s = 0.1; s <= 4; s += 0.05) {
			const cur = typesVisibleAtZoom(s);
			for (const t of prev) expect(cur.has(t)).toBe(true); // no type dropped as scale rises
			prev = cur;
		}
	});
	it("hysteresis: a tiny wiggle around a threshold does not toggle a type", () => {
		const thr = lodThresholdForRank(1); // feature/spec/constraint boundary
		// Establish "on" just above the upper band, then wiggle down slightly.
		const on = typesVisibleAtZoom(thr * 1.15);
		expect(on.has("feature")).toBe(true);
		// Carry the previous set: sitting right at the threshold stays ON (dead-band).
		const wiggleDown = typesVisibleAtZoom(thr * 0.98, { prev: on });
		expect(wiggleDown.has("feature")).toBe(true);
		// Establish "off" just below the lower band, then wiggle up slightly.
		const off = typesVisibleAtZoom(thr * 0.8);
		expect(off.has("feature")).toBe(false);
		const wiggleUp = typesVisibleAtZoom(thr * 1.02, { prev: off });
		expect(wiggleUp.has("feature")).toBe(false); // still off — hasn't cleared upper band
	});
	it("clears the dead-band eventually — a decisive zoom flips the type", () => {
		const thr = lodThresholdForRank(1);
		const off = typesVisibleAtZoom(thr * 0.8);
		const clearlyIn = typesVisibleAtZoom(thr * 1.5, { prev: off });
		expect(clearlyIn.has("feature")).toBe(true);
	});
	it("honours a custom type list", () => {
		const vis = typesVisibleAtZoom(LOD_MAX_SCALE, { types: ["domain", "task"] });
		expect([...vis].sort()).toEqual(["domain", "task"]);
	});
});

describe("effectiveVisibleTypes", () => {
	const lod = new Set(["domain", "feature"]);
	const manual = new Set(["task", "glossary", "domain"]);
	it("uses the LOD set in auto mode (chips ignored)", () => {
		expect(effectiveVisibleTypes("auto", lod, manual)).toEqual(["domain", "feature"]);
	});
	it("uses the manual chip set in manual mode (LOD ignored)", () => {
		// order follows ALL_TYPES, not insertion order
		const eff = effectiveVisibleTypes("manual", lod, manual);
		expect(new Set(eff)).toEqual(new Set(["domain", "task", "glossary"]));
	});
	it("returns a stable ALL_TYPES-ordered array", () => {
		const eff = effectiveVisibleTypes("auto", new Set(ALL_TYPES), new Set());
		expect(eff).toEqual([...ALL_TYPES]);
	});
});

describe("filterMode storage", () => {
	it("namespaces the key per vault", () => {
		expect(filterModeStorageKey("v1")).toBe("brainz:graph:filter-mode:v1");
		expect(filterModeStorageKey("v2")).not.toBe(filterModeStorageKey("v1"));
	});
	it("parses valid modes and defaults everything else to auto", () => {
		expect(parseFilterMode("manual")).toBe("manual");
		expect(parseFilterMode("auto")).toBe("auto");
		expect(parseFilterMode(null)).toBe("auto");
		expect(parseFilterMode(undefined)).toBe("auto");
		expect(parseFilterMode("garbage")).toBe("auto");
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

describe("typeSizeScale / radiusForTypeDegree", () => {
	it("ranks concept largest, domain next, then structural, then leaf/pending", () => {
		expect(typeSizeScale("concept")).toBeGreaterThan(typeSizeScale("domain"));
		expect(typeSizeScale("domain")).toBeGreaterThan(typeSizeScale("feature"));
		expect(typeSizeScale("feature")).toBeGreaterThan(typeSizeScale("glossary"));
		expect(typeSizeScale("glossary")).toBeGreaterThan(typeSizeScale("pending"));
	});
	it("falls back to 1.0 for an unranked type", () => {
		expect(typeSizeScale("totally-made-up")).toBe(1);
	});
	it("scales the degree curve by the type rank (concept dwarfs glossary at equal degree)", () => {
		const base = 6 + Math.sqrt(9) * 2.4; // degree 9
		expect(radiusForTypeDegree("concept", 9)).toBeCloseTo(base * 1.9);
		expect(radiusForTypeDegree("glossary", 9)).toBeCloseTo(base * 0.9);
		expect(radiusForTypeDegree("concept", 9)).toBeGreaterThan(radiusForTypeDegree("glossary", 9));
	});
	it("still grows with degree within a type", () => {
		expect(radiusForTypeDegree("feature", 16)).toBeGreaterThan(radiusForTypeDegree("feature", 1));
	});
	it("treats negative degree as 0 (no NaN)", () => {
		expect(radiusForTypeDegree("concept", -3)).toBeCloseTo(6 * 1.9);
	});
});

describe("typeClusterCenter", () => {
	const types = ["a", "b", "c", "d"];
	it("centers unknown types / degenerate lists on the canvas center", () => {
		expect(typeClusterCenter("zzz", types, 800, 600)).toEqual({ x: 400, y: 300 });
		expect(typeClusterCenter("a", [], 800, 600)).toEqual({ x: 400, y: 300 });
		expect(typeClusterCenter("a", ["a"], 800, 600)).toEqual({ x: 400, y: 300 });
	});
	it("spreads types evenly around a circle (first type at the top)", () => {
		const first = typeClusterCenter("a", types, 800, 600, 100);
		// angle -90°: directly above center → same x, y reduced by radius.
		expect(first.x).toBeCloseTo(400);
		expect(first.y).toBeCloseTo(200);
	});
	it("gives different types different centers", () => {
		const a = typeClusterCenter("a", types, 800, 600);
		const b = typeClusterCenter("b", types, 800, 600);
		expect(a).not.toEqual(b);
	});
	it("places all centers on the ring at the requested radius", () => {
		for (const t of types) {
			const c = typeClusterCenter(t, types, 800, 600, 120);
			expect(Math.hypot(c.x - 400, c.y - 300)).toBeCloseTo(120);
		}
	});
});

describe("focusRevealSet", () => {
	// a—b, a—c (directed a→b, c→a), b—d; e isolated.
	const edges: Edge[] = [
		{ from: "a", to: "b", relation: "references" },
		{ from: "c", to: "a", relation: "depends_on" },
		{ from: "b", to: "d", relation: "references" },
	];

	it("returns an empty set when nothing is focused", () => {
		expect(focusRevealSet(null, edges).size).toBe(0);
	});

	it("includes the focused node and its 1-hop neighbors in BOTH directions", () => {
		// a has an outgoing edge to b and an incoming edge from c → {a, b, c}
		expect([...focusRevealSet("a", edges)].sort()).toEqual(["a", "b", "c"]);
	});

	it("does not reach 2 hops (d is a neighbor of b, not of a)", () => {
		expect(focusRevealSet("a", edges).has("d")).toBe(false);
	});

	it("reveals only itself for an isolated node", () => {
		expect([...focusRevealSet("e", edges)]).toEqual(["e"]);
	});

	it("off-type neighbors still land in the reveal set (type filter is not consulted here)", () => {
		// focusRevealSet is purely edge-driven — a neighbor's type never excludes it.
		expect(focusRevealSet("b", edges).has("d")).toBe(true);
		expect(focusRevealSet("b", edges).has("a")).toBe(true);
	});
});

describe("isDimmed", () => {
	it("dims nothing when no node is focused (empty reveal set)", () => {
		const empty = new Set<string>();
		expect(isDimmed("anything", empty)).toBe(false);
	});

	it("keeps the focused node and its neighbors lit, dims the rest", () => {
		const reveal = new Set(["a", "b", "c"]); // a focused, b/c neighbors
		expect(isDimmed("a", reveal)).toBe(false);
		expect(isDimmed("b", reveal)).toBe(false);
		expect(isDimmed("c", reveal)).toBe(false);
		expect(isDimmed("z", reveal)).toBe(true);
	});
});

describe("isEdgeDimmed", () => {
	it("dims no edge when nothing is focused", () => {
		expect(isEdgeDimmed("a", "b", null)).toBe(false);
		expect(isEdgeDimmed("x", "y", null)).toBe(false);
	});

	it("keeps edges touching the focused node lit (either endpoint), dims others", () => {
		expect(isEdgeDimmed("a", "b", "a")).toBe(false); // a→b, a focused
		expect(isEdgeDimmed("c", "a", "a")).toBe(false); // c→a, a focused (incoming)
		expect(isEdgeDimmed("b", "d", "a")).toBe(true); // neither endpoint is a
	});
});

describe("mergeFocusRender", () => {
	it("is a copy of the culled set when nothing is revealed", () => {
		const culled = new Set(["a", "b"]);
		const merged = mergeFocusRender(culled, new Set());
		expect([...merged].sort()).toEqual(["a", "b"]);
		merged.add("c"); // returned set is independent of the input
		expect(culled.has("c")).toBe(false);
	});

	it("adds focus-set ids the viewport culled away (off-screen neighbors survive)", () => {
		const culled = new Set(["a"]); // only a is on-screen
		const reveal = new Set(["a", "b", "c"]); // b, c are off-screen neighbors
		expect([...mergeFocusRender(culled, reveal)].sort()).toEqual(["a", "b", "c"]);
	});

	it("does not mutate either input", () => {
		const culled = new Set(["a"]);
		const reveal = new Set(["b"]);
		mergeFocusRender(culled, reveal);
		expect([...culled]).toEqual(["a"]);
		expect([...reveal]).toEqual(["b"]);
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

// ------------------------------------------ per-vault type registry (Wave TR)

describe("registryView (weight → LOD rank + size)", () => {
	it("maps the seed registry's distinct weights onto today's exact signal ranks", () => {
		const view = registryView(seedRegistry());
		// domain (weight 100) = rank 0; feature/spec/constraint (80) = 1;
		// story/workflow/pattern/decision (60) = 2; glossary/concept/task (40) = 3.
		expect(view.rank.get("domain")).toBe(0);
		expect(view.rank.get("feature")).toBe(1);
		expect(view.rank.get("spec")).toBe(1);
		expect(view.rank.get("constraint")).toBe(1);
		expect(view.rank.get("story")).toBe(2);
		expect(view.rank.get("glossary")).toBe(3);
		expect(view.rank.get("concept")).toBe(3);
		expect(view.rank.get("task")).toBe(3);
		// pending folds in below every real type at the lowest rank (== maxRank).
		expect(view.rank.get("pending")).toBe(4);
		expect(view.maxRank).toBe(4);
	});

	it("orders and filters hidden types", () => {
		const reg = seedRegistry();
		reg.find((t) => t.key === "glossary")!.hidden = true;
		const view = registryView(reg);
		expect(view.order).toContain("glossary");
		expect(view.visible).not.toContain("glossary");
	});

	it("derives node sizes from weight (higher weight = larger)", () => {
		const view = registryView(seedRegistry());
		const domain = view.size.get("domain")!; // weight 100
		const glossary = view.size.get("glossary")!; // weight 40
		expect(domain).toBeGreaterThan(glossary);
		expect(view.size.get("pending")!).toBeLessThan(glossary); // pending weight 20
	});
});

describe("signalRank / typesVisibleAtZoom with a registry", () => {
	it("the SEED registry reproduces the hardcoded LOD set at every scale (identical behavior)", () => {
		const view = registryView(seedRegistry());
		for (const scale of [0.05, LOD_MIN_SCALE, 0.6, 1, 1.4, LOD_MAX_SCALE, LOD_MAX_SCALE * 1.2, 8]) {
			const hardcoded = [...typesVisibleAtZoom(scale)].sort();
			const fromReg = [...typesVisibleAtZoom(scale, { view })].sort();
			expect(fromReg).toEqual(hardcoded);
		}
	});

	it("re-weighting a type moves its zoom-LOD tier (glossary up to domain's weight → rank 0)", () => {
		const reg = seedRegistry();
		reg.find((t) => t.key === "glossary")!.weight = 100; // promote to the top tier
		const view = registryView(reg);
		expect(signalRank("glossary", view)).toBe(0);
		// Now glossary shows at min zoom alongside domain, where before it was hidden.
		const atMin = typesVisibleAtZoom(LOD_MIN_SCALE, { view });
		expect(atMin.has("glossary")).toBe(true);
		expect(atMin.has("domain")).toBe(true);
	});

	it("a custom type lands in a tier by its weight and reveals at that zoom", () => {
		const reg = seedRegistry();
		reg.push({ key: "risk", label: "Risk", color: "#f00", weight: 100, order: 11, hidden: false, builtin: false });
		const view = registryView(reg);
		expect(signalRank("risk", view)).toBe(0);
		expect(typesVisibleAtZoom(LOD_MIN_SCALE, { view }).has("risk")).toBe(true);
	});
});

describe("radiusForTypeDegree / typeSizeScale with a registry", () => {
	it("re-weighting a type resizes it (heavier = larger radius)", () => {
		const light = registryView(seedRegistry());
		const reg = seedRegistry();
		reg.find((t) => t.key === "glossary")!.weight = 100;
		const heavy = registryView(reg);
		const before = radiusForTypeDegree("glossary", 3, light);
		const after = radiusForTypeDegree("glossary", 3, heavy);
		expect(after).toBeGreaterThan(before);
	});

	it("without a registry, sizing falls back to the built-in TYPE_SIZE_SCALE (unchanged)", () => {
		// concept is the broadest built-in → largest hardcoded scale.
		expect(typeSizeScale("concept")).toBeGreaterThan(typeSizeScale("glossary"));
		expect(radiusForTypeDegree("concept", 0)).toBeGreaterThan(radiusForTypeDegree("glossary", 0));
	});
});

describe("sizeScaleForWeight", () => {
	it("is monotonic in weight and clamps to [lo, hi]", () => {
		expect(sizeScaleForWeight(40, 40, 100)).toBeLessThan(sizeScaleForWeight(100, 40, 100));
		expect(sizeScaleForWeight(40, 40, 100)).toBeCloseTo(0.8); // floor
		expect(sizeScaleForWeight(100, 40, 100)).toBeCloseTo(1.9); // ceil
		expect(sizeScaleForWeight(500, 40, 100)).toBeCloseTo(1.9); // clamp above
	});
	it("maps a degenerate (all-equal) weight range to the midpoint", () => {
		expect(sizeScaleForWeight(50, 50, 50)).toBeCloseTo((0.8 + 1.9) / 2);
	});
});

describe("defaultVisibleTypes with a registry", () => {
	it("keeps today's default set for the seed registry", () => {
		expect(defaultVisibleTypes(seedRegistry())).toEqual(["domain", "feature", "spec", "story", "task"]);
	});
	it("drops a default type that is hidden in the registry", () => {
		const reg = seedRegistry();
		reg.find((t) => t.key === "feature")!.hidden = true;
		expect(defaultVisibleTypes(reg)).toEqual(["domain", "spec", "story", "task"]);
	});
});
