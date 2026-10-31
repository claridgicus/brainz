import { describe, expect, it } from "vitest";
import { buildBackbone, bundleEdges, chevron, straightPath, type BundleEnd } from "./graph-bundle.js";

// Two groups far apart: A at (0,0), B at (1000,0), footprints 100.
const inA = (y: number): BundleEnd => ({ x: 0, y, r: 5, group: "A", gx: 0, gy: 0, gR: 100 });
const inB = (y: number): BundleEnd => ({ x: 1000, y, r: 5, group: "B", gx: 1000, gy: 0, gR: 100 });

/** All coordinates in a path's data. */
const coords = (d: string): Array<[number, number]> =>
	[...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe("bundleEdges", () => {
	it("routes edges between the same groups through shared gates (the pinch)", () => {
		const edges = [-60, -20, 20, 60].map((y, i) => ({ key: `e${i}`, a: inA(y), b: inB(-y), strands: 1 }));
		const res = bundleEdges(edges, { gap: 3 });
		expect(res.paths.size).toBe(4);
		// Every strand passes within a few lane gaps of A's east gate (85, 0) and B's west gate (915, 0).
		for (const d of res.paths.values()) {
			const pts = coords(d);
			const nearA = Math.min(...pts.map(([x, y]) => Math.hypot(x - 85, y)));
			const nearB = Math.min(...pts.map(([x, y]) => Math.hypot(x - 915, y)));
			expect(nearA).toBeLessThan(8);
			expect(nearB).toBeLessThan(8);
		}
		// One gate per side carries all four strands → two cable-ties.
		expect(res.ties.length).toBe(2);
		expect(res.bundles).toBe(2);
	});

	it("keeps strands slightly apart inside a bundle (not merged)", () => {
		const edges = [-40, 40].map((y, i) => ({ key: `e${i}`, a: inA(y), b: inB(y), strands: 1 }));
		const res = bundleEdges(edges, { gap: 3 });
		const midY = (d: string): number => {
			const pts = coords(d);
			// middle segment's control points sit at index 4,5 of the 10-point chain
			return (pts[4]![1] + pts[5]![1]) / 2;
		};
		expect(Math.abs(midY(res.paths.get("e0")!) - midY(res.paths.get("e1")!))).toBeGreaterThan(1);
	});

	it("orders lanes so strands don't cross at the gate", () => {
		const edges = [
			{ key: "top", a: inA(-50), b: inB(-80), strands: 1 },
			{ key: "bot", a: inA(50), b: inB(80), strands: 1 },
		];
		const res = bundleEdges(edges, { gap: 3 });
		const gateY = (d: string): number => coords(d)[3]![1]; // A1, the pinch point at gate A
		expect(gateY(res.paths.get("top")!)).toBeLessThan(gateY(res.paths.get("bot")!));
	});

	it("starts at the source and ends at the target circle borders", () => {
		const res = bundleEdges([{ key: "e", a: inA(0), b: inB(0), strands: 1 }]);
		const pts = coords(res.paths.get("e")!);
		expect(Math.hypot(pts[0]![0], pts[0]![1])).toBeCloseTo(6, 0); // r + 1
		const last = pts[pts.length - 1]!;
		expect(Math.hypot(last[0] - 1000, last[1])).toBeCloseTo(8, 0); // r + 3
	});

	it("draws an aggregated edge as several parallel strands", () => {
		const res = bundleEdges([{ key: "agg", a: inA(0), b: inB(0), strands: 3 }]);
		expect(res.paths.get("agg")!.match(/M/g)!.length).toBe(3);
	});

	it("adds an arrowhead chevron for typed edges", () => {
		const res = bundleEdges([{ key: "e", a: inA(0), b: inB(0), strands: 1, arrow: true }]);
		expect(res.paths.get("e")!.match(/M/g)!.length).toBe(2);
		expect(res.paths.get("e")!).toContain("L");
	});

	it("draws same-group and touching-group edges as plain bowed curves", () => {
		const a: BundleEnd = { x: 0, y: 0, r: 5, group: "A", gx: 0, gy: 0, gR: 100 };
		const b: BundleEnd = { x: 50, y: 50, r: 5, group: "A", gx: 0, gy: 0, gR: 100 };
		const res = bundleEdges([{ key: "e", a, b, strands: 1 }]);
		expect(res.paths.get("e")!.match(/C/g)!.length).toBe(1);
		expect(res.ties).toEqual([]);
		expect(res.bundles).toBe(0);
	});

	it("is deterministic", () => {
		const edges = [-30, 0, 30].map((y, i) => ({ key: `e${i}`, a: inA(y), b: inB(y), strands: 1 + (i % 2) }));
		expect(bundleEdges(edges).paths).toEqual(bundleEdges(edges).paths);
	});
});

// Two regions of five discs each, far apart: west around (0,0), east around (2000,0).
const regions = [
	...[0, 1, 2, 3, 4].map((k) => ({ id: `w${k}`, x: Math.cos(k * 1.26) * 300, y: Math.sin(k * 1.26) * 300, R: 60 })),
	...[0, 1, 2, 3, 4].map((k) => ({ id: `e${k}`, x: 2000 + Math.cos(k * 1.26) * 300, y: Math.sin(k * 1.26) * 300, R: 60 })),
];
const disc = (id: string, hub: number): BundleEnd => {
	const g = regions.find((r) => r.id === id)!;
	return { x: g.x, y: g.y, r: 20, group: id, gx: g.x, gy: g.y, gR: 30, hub };
};

describe("buildBackbone", () => {
	it("groups discs into super-groups with a hub each, joined by trunks", () => {
		const bb = buildBackbone(regions, { hubs: 2 });
		expect(bb.hubs.length).toBe(2);
		expect(bb.links).toEqual([[0, 1]]);
		const west = bb.hubOf.get("w0");
		for (let k = 0; k < 5; k++) {
			expect(bb.hubOf.get(`w${k}`)).toBe(west);
			expect(bb.hubOf.get(`e${k}`)).not.toBe(west);
		}
		expect(bb.next[0]![1]).toBe(1);
	});

	it("keeps hubs off the discs", () => {
		const bb = buildBackbone(regions, { hubs: 2, margin: 30 });
		for (const h of bb.hubs) for (const g of regions) expect(Math.hypot(h.x - g.x, h.y - g.y)).toBeGreaterThanOrEqual(g.R + 29);
	});

	it("is empty for a handful of groups", () => {
		expect(buildBackbone(regions.slice(0, 4)).hubs).toEqual([]);
	});

	it("routes over a spanning tree, with paths for every hub pair", () => {
		const grid = Array.from({ length: 36 }, (_, i) => ({ id: `g${i}`, x: (i % 6) * 400, y: Math.floor(i / 6) * 400, R: 50 }));
		const bb = buildBackbone(grid);
		const K = bb.hubs.length;
		expect(K).toBeGreaterThanOrEqual(3);
		expect(bb.links.length).toBeGreaterThanOrEqual(K - 1);
		for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) expect(bb.next[i]![j]).toBeGreaterThanOrEqual(0);
	});
});

describe("bundleEdges with a backbone", () => {
	const bb = buildBackbone(regions, { hubs: 2 });
	const W = bb.hubOf.get("w0")!;
	const E = bb.hubOf.get("e0")!;
	const cross = [0, 1, 2, 3, 4].map((k) => ({ key: `x${k}`, a: disc(`w${k}`, W), b: disc(`e${(k + 2) % 5}`, E), strands: 1, weight: 2 }));

	it("routes edges between super-groups along one shared trunk, labelled with the link count", () => {
		const res = bundleEdges(cross, { gap: 3, backbone: bb });
		expect(res.trunks.length).toBe(1);
		expect(res.trunks[0]!.count).toBe(10);
		// Every strand passes the trunk's midpoint within the trunk width.
		const mid = { x: (bb.hubs[0]!.x + bb.hubs[1]!.x) / 2, y: (bb.hubs[0]!.y + bb.hubs[1]!.y) / 2 };
		for (const d of res.paths.values()) {
			const near = Math.min(...coords(d).map(([x, y]) => Math.hypot(x - mid.x, y - mid.y)));
			expect(near).toBeLessThan(40);
		}
		// Cable-ties pinch the trunk by each hub; edges on the trunk carry no per-edge label.
		expect(res.ties.length).toBeGreaterThanOrEqual(2);
		expect(res.mids.size).toBe(0);
	});

	it("keeps the strands apart along the trunk (parallel lanes, not one line)", () => {
		const res = bundleEdges(cross, { gap: 3, backbone: bb });
		const mid = { x: (bb.hubs[0]!.x + bb.hubs[1]!.x) / 2, y: (bb.hubs[0]!.y + bb.hubs[1]!.y) / 2 };
		const ys = [...res.paths.values()].map((d) => {
			const pts = coords(d);
			let best = pts[0]!;
			for (const p of pts) if (Math.hypot(p[0] - mid.x, p[1] - mid.y) < Math.hypot(best[0] - mid.x, best[1] - mid.y)) best = p;
			return best[1];
		});
		expect(new Set(ys.map((y) => y.toFixed(1))).size).toBe(5);
	});

	it("leaves edges within one super-group on direct gate routes", () => {
		const res = bundleEdges([{ key: "w", a: disc("w0", W), b: disc("w2", W), strands: 1 }], { backbone: bb });
		expect(res.trunks).toEqual([]);
		expect(res.mids.has("w")).toBe(true);
	});

	it("never doubles back: a group past the tie joins the trunk further in", () => {
		// e0 sits on the west side of the east region — between the hubs' ties.
		const res = bundleEdges(cross, { gap: 3, backbone: bb });
		for (const d of res.paths.values()) {
			const xs = coords(d).map(([x]) => x);
			// Monotone-ish west → east: no point runs back more than a lane or two.
			let maxX = -Infinity;
			for (const x of xs) {
				expect(x).toBeGreaterThan(maxX - 200);
				maxX = Math.max(maxX, x);
			}
		}
	});
});

describe("chevron / straightPath", () => {
	it("chevron tip is the given point", () => {
		expect(chevron({ x: 10, y: 0 }, { x: 0, y: 0 }, 4)).toContain("L10,0");
	});
	it("straightPath trims to both borders and can carry an arrow", () => {
		const d = straightPath(inA(0), inB(0));
		expect(d).toBe("M6,0L992,0");
		expect(straightPath(inA(0), inB(0), 5).match(/M/g)!.length).toBe(2);
	});
});
