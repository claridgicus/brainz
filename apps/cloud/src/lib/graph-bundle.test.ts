import { describe, expect, it } from "vitest";
import { bundleEdges, chevron, straightPath, type BundleEnd } from "./graph-bundle.js";

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
