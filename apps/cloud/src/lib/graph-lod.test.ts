import { describe, expect, it } from "vitest";
import type { Edge, GraphNode } from "@brainz/contracts";
import {
	COLLAPSE_PX,
	EXPAND_PX,
	allocateBudget,
	bubbleRadius,
	buildClusters,
	clusterFootprint,
	clusterLinks,
	expandScaleFor,
	expansionCandidates,
	fullDetailIds,
	labelCollideRadius,
	spiralSeed,
	truncateLabel,
	type ClusterGeom,
} from "./graph-lod.js";
import { syntheticGraph } from "../../bench/graph/synthetic.js";

const node = (id: string, type = "feature", extra: Partial<GraphNode> = {}): GraphNode => ({
	id,
	title: id,
	type,
	tags: [],
	degree: 0,
	...extra,
});
const partOf = (from: string, to: string): Edge => ({ from, to, relation: "part_of" });

describe("buildClusters", () => {
	it("groups concepts under the root of their part_of chain", () => {
		const nodes = [node("d", "domain"), node("f", "feature"), node("s", "story"), node("x", "spec")];
		const edges = [partOf("f", "d"), partOf("s", "f"), { from: "x", to: "f", relation: "governs" }];
		const { clusters, clusterOf } = buildClusters(nodes, edges);
		expect(clusterOf.get("s")).toBe("@c:d");
		expect(clusterOf.get("f")).toBe("@c:d");
		expect(clusterOf.get("d")).toBe("@c:d");
		const c = clusters.get("@c:d")!;
		expect(c.head).toBe("d");
		expect(c.title).toBe("d");
		expect(c.type).toBe("domain");
		// no part_of parent and no children → per-type fallback cluster
		expect(clusterOf.get("x")).toBe("@c:~spec");
		expect(clusters.get("@c:~spec")!.title).toBe("Unfiled spec");
	});

	it("is cycle-safe", () => {
		const nodes = [node("a"), node("b")];
		const { clusterOf } = buildClusters(nodes, [partOf("a", "b"), partOf("b", "a")]);
		expect(clusterOf.get("a")).toBeDefined();
		expect(clusterOf.get("b")).toBeDefined();
	});

	it("puts pending (broken-link) concepts in their own fallback cluster", () => {
		const { clusterOf } = buildClusters([node("p", "concept", { pending: true })], []);
		expect(clusterOf.get("p")).toBe("@c:~pending");
	});

	it("splits oversized clusters by type, then into chunks", () => {
		const nodes = [node("d", "domain")];
		const edges: Edge[] = [];
		for (let i = 0; i < 25; i++) {
			nodes.push(node(`t${i}`, "task"));
			edges.push(partOf(`t${i}`, "d"));
		}
		for (let i = 0; i < 5; i++) {
			nodes.push(node(`s${i}`, "spec"));
			edges.push(partOf(`s${i}`, "d"));
		}
		const { clusters, clusterOf } = buildClusters(nodes, edges, 10);
		for (const c of clusters.values()) expect(c.members.length).toBeLessThanOrEqual(10);
		const all = [...clusters.values()].flatMap((c) => c.members);
		expect(new Set(all).size).toBe(nodes.length);
		expect(clusterOf.get("s0")).toBe("@c:d/spec");
		expect(clusters.get("@c:d/domain")!.head).toBe("d");
	});

	it("covers every concept of a synthetic vault exactly once", () => {
		const g = syntheticGraph(2000);
		const { clusters, clusterOf } = buildClusters(g.nodes, g.edges);
		expect(clusterOf.size).toBe(2000);
		expect([...clusters.values()].reduce((s, c) => s + c.members.length, 0)).toBe(2000);
		expect(clusters.size).toBe(50); // one per domain
	});
});

describe("clusterLinks", () => {
	it("aggregates edges between clusters with a weight, dropping intra-cluster edges", () => {
		const nodes = [node("a", "domain"), node("a1"), node("b", "domain"), node("b1"), node("b2")];
		const edges = [
			partOf("a1", "a"),
			partOf("b1", "b"),
			partOf("b2", "b"),
			{ from: "a1", to: "b1", relation: "depends_on" },
			{ from: "b2", to: "a", relation: "related_to" },
			{ from: "b1", to: "b2", relation: "related_to" },
		];
		const links = clusterLinks(buildClusters(nodes, edges), edges);
		expect(links).toEqual([{ a: "@c:a", b: "@c:b", weight: 2 }]);
	});
});

describe("sizing", () => {
	it("truncates long labels and sizes collision to the label", () => {
		expect(truncateLabel("short")).toBe("short");
		const long = "A very long concept title that keeps going";
		expect(truncateLabel(long).length).toBeLessThanOrEqual(26);
		expect(truncateLabel(long).endsWith("…")).toBe(true);
		expect(labelCollideRadius("ab", 6)).toBe(22); // circle-bound
		expect(labelCollideRadius(long, 6)).toBeGreaterThan(80); // label-bound
	});

	it("footprint grows with members; bubble scales with footprint", () => {
		const small = clusterFootprint(Array(10).fill(30));
		const big = clusterFootprint(Array(100).fill(30));
		expect(big).toBeGreaterThan(small * 2.5);
		expect(clusterFootprint([12])).toBe(12);
		expect(bubbleRadius(10)).toBe(22);
		expect(bubbleRadius(400)).toBeGreaterThan(100);
	});

	it("spiral seeds keep discs apart, largest at the centre", () => {
		const radii = [50, 300, 80, 120];
		const pts = spiralSeed(radii);
		expect(pts[1]).toEqual({ x: 0, y: 0 });
		for (let i = 0; i < radii.length; i++) {
			for (let j = i + 1; j < radii.length; j++) {
				const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
				expect(d).toBeGreaterThan(Math.max(radii[i]!, radii[j]!));
			}
		}
	});
});

describe("expansionCandidates", () => {
	const view = { x: 0, y: 0, k: 1, width: 1000, height: 800 };
	const c = (id: string, x: number, y: number, R: number, size = 20): ClusterGeom => ({ id, x, y, R, size });

	it("needs the footprint to be big enough on screen, with hysteresis", () => {
		const big = c("big", 500, 400, EXPAND_PX + 10);
		const mid = c("mid", 500, 400, (EXPAND_PX + COLLAPSE_PX) / 2);
		expect(expansionCandidates([big, mid], view, new Set()).map((x) => x.id)).toEqual(["big"]);
		// already open: stays a candidate down to COLLAPSE_PX
		expect(expansionCandidates([mid], view, new Set(["mid"])).map((x) => x.id)).toEqual(["mid"]);
		expect(expansionCandidates([c("tiny", 500, 400, COLLAPSE_PX - 5)], view, new Set(["tiny"]))).toEqual([]);
	});

	it("skips clusters off screen and always admits lone concepts on screen", () => {
		const off = c("off", 5000, 400, 300);
		const lone = c("lone", 100, 100, 10, 1);
		expect(expansionCandidates([off, lone], view, new Set()).map((x) => x.id)).toEqual(["lone"]);
	});

	it("orders by distance from the centre; open clusters get a sticky bonus; manual wins", () => {
		const near = c("near", 520, 400, 150);
		const far = c("far", 900, 400, 150);
		expect(expansionCandidates([far, near], view, new Set()).map((x) => x.id)).toEqual(["near", "far"]);
		const sticky = expansionCandidates([far, c("near2", 770, 400, 150)], view, new Set(["far"]));
		expect(sticky[0]!.id).toBe("far");
		expect(expansionCandidates([near, far], view, new Set(), new Set(["far"]))[0]!.id).toBe("far");
	});

	it("manual expansion ignores the size threshold", () => {
		const small = c("small", 500, 400, 20);
		expect(expansionCandidates([small], view, new Set(), new Set(["small"])).map((x) => x.id)).toEqual(["small"]);
	});
});

describe("allocateBudget", () => {
	it("opens candidates in order until the budget runs out, the next one partially", () => {
		const cands = [
			{ id: "a", score: 0 },
			{ id: "b", score: 1 },
			{ id: "c", score: 2 },
		];
		const counts = new Map([
			["a", 60],
			["b", 60],
			["c", 60],
		]);
		const out = allocateBudget(cands, counts, 100);
		expect(out.get("a")).toBe(60);
		expect(out.get("b")).toBe(40); // partial: 40 >= 25% of 60
		expect(out.has("c")).toBe(false); // collapsed
		expect([...out.values()].reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(100);
	});

	it("keeps a cluster collapsed rather than opening a sliver of it", () => {
		const out = allocateBudget(
			[
				{ id: "a", score: 0 },
				{ id: "b", score: 1 },
			],
			new Map([
				["a", 95],
				["b", 100],
			]),
			100,
		);
		expect(out.get("a")).toBe(95);
		expect(out.has("b")).toBe(false);
	});

	it("never exceeds the budget (hard cap)", () => {
		const cands = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, score: i }));
		const counts = new Map(cands.map((c, i) => [c.id, 10 + (i % 7) * 13]));
		for (const budget of [0, 37, 400]) {
			const out = allocateBudget(cands, counts, budget);
			expect([...out.values()].reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(budget);
		}
	});
});

describe("fullDetailIds", () => {
	it("labels the nodes nearest the centre, plus `always` ids", () => {
		const view = { width: 1000, height: 800 };
		const pts = [
			{ id: "c", sx: 500, sy: 400 },
			{ id: "n", sx: 560, sy: 400 },
			{ id: "f", sx: 900, sy: 700 },
			{ id: "edge", sx: 1000, sy: 800 },
		];
		const out = fullDetailIds(pts, view, 2, new Set(["edge"]));
		expect([...out].sort()).toEqual(["c", "edge", "n"]);
	});
});

describe("expandScaleFor", () => {
	it("zooms in enough for the footprint to clear the expand threshold", () => {
		const k = expandScaleFor(200, 0.2);
		expect(200 * k).toBeGreaterThan(EXPAND_PX);
		expect(expandScaleFor(200, 3)).toBe(3); // never zooms out
		expect(expandScaleFor(1, 1)).toBe(8); // clamped
	});
});
