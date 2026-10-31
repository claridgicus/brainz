import { describe, expect, it } from "vitest";
import type { Edge, GraphNode } from "@brainz/contracts";
import {
	COLLAPSE_PX,
	EXPAND_PX,
	MIN_AUTO_K,
	allocateBudget,
	bubbleRadius,
	buildClusters,
	clusterFootprint,
	clusterLinks,
	expandScaleFor,
	expandPolicyKey,
	OPEN_PX,
	parseExpandPolicy,
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

const link = (from: string, to: string, relation = "depends_on"): Edge => ({ from, to, relation });

describe("buildClusters", () => {
	it("groups a domain with what hangs off it and links to it, named after the domain", () => {
		const nodes = [node("d", "domain"), node("f", "feature"), node("s", "story"), node("x", "spec")];
		const edges = [partOf("f", "d"), partOf("s", "f"), { from: "x", to: "f", relation: "governs" }];
		const { clusters, clusterOf } = buildClusters(nodes, edges);
		// The parentless spec links into the domain's community — no "Unfiled spec" bucket.
		for (const id of ["d", "f", "s", "x"]) expect(clusterOf.get(id)).toBe("@c:d");
		const c = clusters.get("@c:d")!;
		expect(c.head).toBe("d");
		expect(c.title).toBe("d");
		expect(c.type).toBe("domain");
		expect(clusters.size).toBe(1);
	});

	it("clusters by link, not by type: parentless tasks join the domain they link into", () => {
		// Two domains, each with features; tasks have no part_of and link into one
		// domain's features. The old rule put every task in one "Unfiled task" bucket.
		const nodes = [node("a", "domain"), node("b", "domain")];
		const edges: Edge[] = [];
		for (const d of ["a", "b"]) {
			for (let i = 0; i < 4; i++) {
				nodes.push(node(`${d}-f${i}`, "feature"));
				edges.push(partOf(`${d}-f${i}`, d));
				if (i > 0) edges.push(link(`${d}-f${i}`, `${d}-f${i - 1}`, "related_to"));
			}
		}
		for (let t = 0; t < 12; t++) {
			const d = t % 2 === 0 ? "a" : "b";
			nodes.push(node(`task-${t}`, "task"));
			edges.push(link(`task-${t}`, `${d}-f${t % 4}`, "realizes"), link(`task-${t}`, `${d}-f${(t + 1) % 4}`));
		}
		const { clusters, clusterOf } = buildClusters(nodes, edges);
		for (let t = 0; t < 12; t++) expect(clusterOf.get(`task-${t}`)).toBe(t % 2 === 0 ? "@c:a" : "@c:b");
		expect([...clusters.keys()].sort()).toEqual(["@c:a", "@c:b"]);
		for (const c of clusters.values()) {
			expect(c.title.startsWith("Unfiled")).toBe(false);
			expect(new Set(c.members.map((m) => nodes.find((n) => n.id === m)!.type)).size).toBeGreaterThan(1);
		}
	});

	it("follows the links when they disagree with part_of", () => {
		// x is filed under domain a but all its links go to b's members.
		const nodes = [node("a", "domain"), node("a1"), node("a2"), node("b", "domain"), node("b1"), node("b2"), node("x")];
		const edges = [
			partOf("a1", "a"), partOf("a2", "a"), link("a1", "a2"),
			partOf("b1", "b"), partOf("b2", "b"), link("b1", "b2"),
			partOf("x", "a"),
			link("x", "b"), link("x", "b1"), link("x", "b2"), link("b1", "x", "realizes"),
		];
		expect(buildClusters(nodes, edges).clusterOf.get("x")).toBe("@c:b");
	});

	it("names a domain-less community after its best-connected concept", () => {
		const nodes = [node("hub", "spec"), node("s1", "story"), node("s2", "task"), node("s3", "decision")];
		const edges = [link("s1", "hub"), link("s2", "hub"), link("s3", "hub"), link("s1", "s2")];
		const { clusters } = buildClusters(nodes, edges);
		expect([...clusters.keys()]).toEqual(["@c:hub"]);
		expect(clusters.get("@c:hub")!.type).toBe("spec");
	});

	it("attaches near-isolated concepts and groups only edgeless ones as loose", () => {
		const nodes = [node("d", "domain"), node("f"), node("g"), node("leaf", "task"), node("lonely1", "task"), node("lonely2", "spec")];
		const edges = [partOf("f", "d"), partOf("g", "d"), link("f", "g"), link("leaf", "f")];
		const { clusters, clusterOf } = buildClusters(nodes, edges);
		expect(clusterOf.get("leaf")).toBe("@c:d");
		expect(clusterOf.get("lonely1")).toBe("@c:~loose");
		expect(clusterOf.get("lonely2")).toBe("@c:~loose");
		expect(clusters.get("@c:~loose")!.title).toBe("Loose concepts");
		expect(clusters.size).toBe(2);
	});

	it("is cycle-safe and keeps pending concepts with what links to them", () => {
		const { clusterOf } = buildClusters([node("a"), node("b")], [partOf("a", "b"), partOf("b", "a")]);
		expect(clusterOf.get("a")).toBe(clusterOf.get("b"));
		const p = buildClusters([node("d", "domain"), node("p", "concept", { pending: true })], [link("d", "p", "references")]);
		expect(p.clusterOf.get("p")).toBe("@c:d");
	});

	it("is deterministic and independent of input order", () => {
		const g = syntheticGraph(800, 7, 14);
		const a = buildClusters(g.nodes, g.edges);
		const b = buildClusters([...g.nodes].reverse(), [...g.edges].reverse());
		expect([...b.clusterOf].sort()).toEqual([...a.clusterOf].sort());
	});

	it("splits oversized communities, every part under the cap", () => {
		const nodes = [node("d", "domain")];
		const edges: Edge[] = [];
		for (let i = 0; i < 30; i++) {
			nodes.push(node(`t${i}`, i % 5 ? "task" : "spec"));
			edges.push(partOf(`t${i}`, "d"));
			if (i > 0) edges.push(link(`t${i}`, `t${i - 1}`));
		}
		const { clusters } = buildClusters(nodes, edges, 10);
		for (const c of clusters.values()) expect(c.members.length).toBeLessThanOrEqual(10);
		const all = [...clusters.values()].flatMap((c) => c.members);
		expect(all.length).toBe(nodes.length);
		expect(new Set(all).size).toBe(nodes.length);
		expect([...clusters.values()].every((c) => !c.title.startsWith("Unfiled"))).toBe(true);
		expect([...clusters.values()].some((c) => c.head === "d")).toBe(true);
	});

	it("covers every concept of a synthetic vault exactly once, in link communities", () => {
		const g = syntheticGraph(2000);
		const { clusters, clusterOf } = buildClusters(g.nodes, g.edges);
		expect(clusterOf.size).toBe(2000);
		expect([...clusters.values()].reduce((s, c) => s + c.members.length, 0)).toBe(2000);
		// Synthetic domains are link-local, so communities track them (~one each).
		expect(clusters.size).toBeGreaterThan(30);
		expect(clusters.size).toBeLessThan(80);
		expect([...clusters.keys()].every((id) => !id.startsWith("@c:~") || id.startsWith("@c:~loose"))).toBe(true);
	});

	it("runs within the per-load budget on a 5k vault", () => {
		const g = syntheticGraph(5000);
		const t0 = performance.now();
		buildClusters(g.nodes, g.edges);
		expect(performance.now() - t0).toBeLessThan(1500); // ~tens of ms in practice; loose bound for CI
	});
});

describe("clusterLinks", () => {
	it("aggregates edges between clusters with a weight, dropping intra-cluster edges", () => {
		const nodes = [node("a", "domain"), node("a1"), node("a2"), node("b", "domain"), node("b1"), node("b2")];
		const edges = [
			partOf("a1", "a"),
			partOf("a2", "a"),
			{ from: "a1", to: "a2", relation: "related_to" },
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

	it("bigger clusters on screen claim the budget before smaller ones at a similar distance", () => {
		// Both centred 300px out; the big one's edge is nearer AND it gets the size bonus.
		const bigFar = c("big", 500, 100, 120);
		const smallNear = c("small", 500, 640, EXPAND_PX + 2);
		expect(expansionCandidates([smallNear, bigFar], view, new Set()).map((x) => x.id)).toEqual(["big", "small"]);
		// The size bonus alone flips a near-tie: same edge distance, bigger first.
		const a = c("a", 500 + 200 + 60, 400, 60);
		const b = c("b", 500 - 200 - 120, 400, 120);
		expect(expansionCandidates([a, b], view, new Set()).map((x) => x.id)).toEqual(["b", "a"]);
	});

	it("the fitted overview of a mid-size vault qualifies (discs ~40–90px on screen)", () => {
		const k = 0.3;
		const discs = [150, 200, 300].map((R, i) => c(`d${i}`, (i - 1) * 900, 0, R));
		const v = { x: 500, y: 400, k, width: 1000, height: 800 };
		expect(expansionCandidates(discs, v, new Set()).map((x) => x.id).sort()).toEqual(["d0", "d1", "d2"]);
	});

	it("never auto-expands below MIN_AUTO_K (overview of a 2k+ vault), with hysteresis", () => {
		const big = c("big", 0, 0, 600); // 72px on screen at k=0.12 — big enough, but too far out
		const at = (k: number) => ({ x: 500, y: 400, k, width: 1000, height: 800 });
		expect(expansionCandidates([big], at(MIN_AUTO_K * 0.8), new Set())).toEqual([]);
		expect(expansionCandidates([big], at(MIN_AUTO_K), new Set()).map((x) => x.id)).toEqual(["big"]);
		expect(expansionCandidates([big], at(MIN_AUTO_K * 0.9), new Set(["big"])).map((x) => x.id)).toEqual(["big"]);
		expect(expansionCandidates([big], at(MIN_AUTO_K * 0.8), new Set(), new Set(), 120, "all").map((x) => x.id)).toEqual(["big"]);
	});

	it("policy 'all' drops the size test; 'none' admits only manual clusters", () => {
		const small = c("small", 500, 400, 5);
		const lone = c("lone", 100, 100, 10, 1);
		const off = c("off", 5000, 400, 300);
		expect(expansionCandidates([small, off], view, new Set(), new Set(), 120, "all").map((x) => x.id)).toEqual(["small"]);
		expect(expansionCandidates([small, lone], view, new Set(), new Set(), 120, "none")).toEqual([]);
		expect(expansionCandidates([small, lone], view, new Set(["small"]), new Set(["small"]), 120, "none").map((x) => x.id)).toEqual(["small"]);
	});
});

describe("expand policy storage", () => {
	it("parses known policies and falls back to auto", () => {
		expect(parseExpandPolicy("all")).toBe("all");
		expect(parseExpandPolicy("none")).toBe("none");
		expect(parseExpandPolicy("auto")).toBe("auto");
		expect(parseExpandPolicy(null)).toBe("auto");
		expect(parseExpandPolicy("bogus")).toBe("auto");
		expect(expandPolicyKey("v1")).toBe("brainz:graph-expand:v1");
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
		expect(200 * k).toBeCloseTo(OPEN_PX);
		expect(expandScaleFor(200, 3)).toBe(3); // never zooms out
		expect(expandScaleFor(1, 1)).toBe(8); // clamped
	});
});
