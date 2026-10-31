// Edge bundling ("ziptie") for the cloud graph — pure geometry, no DOM.
//
// Hierarchical bundling over the cluster hierarchy: an edge leaving a group
// (a cluster, or a lone node / bubble acting as its own group) exits through a
// GATE on the group's footprint — one gate per compass sector (SECTORS of them),
// picked by the direction of the edge's far group. Every edge heading the same
// way out of a group shares that gate, so they converge there into a pinch
// (the cable-tie), leave side by side as parallel strands along the gate's
// outward tangent, curve smoothly to the far group's gate and fan back out to
// their endpoints. Strands keep a small lane gap (never merged into one thick
// line), ordered at each gate by where they are headed so they don't cross.
//
// Backbone (cluster overview): with a `Backbone` the cluster discs are grouped
// into a handful of super-groups, each with a HUB in the open space between its
// discs; hubs are joined by a spanning tree (plus a few shortcuts). An edge
// whose ends sit in different super-groups leaves its group's gate, converges
// on its hub and rides the hub path as a TRUNK — every edge between the same
// regions shares the same cable run, so the overview reads as a few clear runs
// instead of a hairball. Trunks pinch at a cable-tie near each hub, run as
// parallel strands between them and report their link count.
//
// Computed once per layout / render-set change (never per frame) — the caller
// caches the result.

export interface BundleEnd {
	/** endpoint centre + radius (the path is trimmed to the circle border) */
	x: number;
	y: number;
	r: number;
	/** group id (cluster id; a lone node or bubble is its own group) */
	group: string;
	/** group centre + footprint radius (gate placement) */
	gx: number;
	gy: number;
	gR: number;
	/** backbone hub of the end's super-group (see `buildBackbone`) */
	hub?: number;
}

export interface BundleInput {
	key: string;
	a: BundleEnd;
	b: BundleEnd;
	/** parallel strands to draw (1, or min(weight, cap) for an aggregated edge) */
	strands: number;
	/** draw an arrowhead chevron at the `b` end (typed relations) */
	arrow?: boolean;
	/** links this edge stands for (trunk counts); defaults to 1 */
	weight?: number;
	/** with a backbone, route through the shared hub even when both ends are in
	 * the same super-group (overview bubble ↔ bubble edges) */
	viaHub?: boolean;
}

export interface Tie {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface BundleResult {
	/** edge key → SVG path data (one subpath per strand) */
	paths: Map<string, string>;
	/** edge key → a point on the path's middle (weight labels) */
	mids: Map<string, { x: number; y: number }>;
	/** cable-tie marks at the pinch points of bundles with >= 3 strands */
	ties: Tie[];
	/** backbone trunks: midpoint + how many links ride it (count labels) */
	trunks: Array<{ x: number; y: number; count: number }>;
	bundles: number;
}

/** Super-group hubs and the routes between them (see `buildBackbone`). */
export interface Backbone {
	hubs: Array<{ x: number; y: number }>;
	/** hub pairs joined by a trunk */
	links: Array<[number, number]>;
	/** next[i][j] = next hub on the shortest trunk path i → j (-1 = unreachable) */
	next: number[][];
	/** group id → hub index */
	hubOf: Map<string, number>;
}

export interface BundleOptions {
	/** lane gap between parallel strands (graph units) */
	gap?: number;
	/** how far out on the footprint the gate sits (fraction of gR) */
	gateFrac?: number;
	/** a gate carrying at least this many strands draws a cable-tie */
	tieMin?: number;
	/** gates per group (compass sectors) */
	sectors?: number;
	/** arrowhead chevron length (graph units) */
	arrowSize?: number;
	/** route edges between super-groups along these trunks */
	backbone?: Backbone | null;
	/** max total width of a trunk's strands (graph units); lanes shrink to fit */
	trunkWidth?: number;
	/** cable-tie overhang past the outermost strand (graph units) */
	tiePad?: number;
}

type P = { x: number; y: number };

const f = (n: number): string => (Math.round(n * 10) / 10).toString();
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: P, s: number): P => ({ x: a.x * s, y: a.y * s });
const len = (a: P): number => Math.hypot(a.x, a.y);
const unit = (a: P): P => {
	const l = len(a) || 1;
	return { x: a.x / l, y: a.y / l };
};
/** Point on the circle (c, r) facing `toward`. */
const trim = (c: P, r: number, toward: P): P => add(c, mul(unit(sub(toward, c)), r));

/** Serialize a chain of cubic segments [p0, c1, c2, p1, c1, c2, p2, …]. */
function cubicPath(pts: P[]): string {
	let d = `M${f(pts[0]!.x)},${f(pts[0]!.y)}`;
	for (let i = 1; i + 2 < pts.length; i += 3) {
		d += `C${f(pts[i]!.x)},${f(pts[i]!.y)} ${f(pts[i + 1]!.x)},${f(pts[i + 1]!.y)} ${f(pts[i + 2]!.x)},${f(pts[i + 2]!.y)}`;
	}
	return d;
}

/**
 * Arrowhead as an open chevron subpath at `tip`, pointing away from `from` —
 * part of the edge's own path data, so it costs no SVG marker instance.
 */
export function chevron(tip: P, from: P, size: number): string {
	const d = unit(sub(tip, from));
	const p: P = { x: -d.y, y: d.x };
	const back = sub(tip, mul(d, size));
	const l = add(back, mul(p, size * 0.55));
	const r = sub(back, mul(p, size * 0.55));
	return `M${f(l.x)},${f(l.y)}L${f(tip.x)},${f(tip.y)}L${f(r.x)},${f(r.y)}`;
}

/** A gently bowed single curve u → v, strands offset sideways by `offsets`. */
function plainCurve(a: BundleEnd, b: BundleEnd, offsets: number[], bowSign: number, arrow: number): { d: string; mid: P } {
	const u: P = { x: a.x, y: a.y };
	const v: P = { x: b.x, y: b.y };
	const dir = unit(sub(v, u));
	const perp: P = { x: -dir.y, y: dir.x };
	const L = len(sub(v, u));
	const bow = Math.min(60, L * 0.12) * bowSign;
	let d = "";
	let mid: P = u;
	for (const o of offsets) {
		const c1 = add(add(u, mul(dir, L / 3)), mul(perp, bow + o));
		const c2 = add(add(u, mul(dir, (2 * L) / 3)), mul(perp, bow + o));
		const s = trim(u, a.r + 1, c1);
		const e = trim(v, b.r + 3, c2);
		d += cubicPath([s, c1, c2, e]);
		if (arrow > 0) d += chevron(e, c2, arrow);
		mid = add(add(u, mul(dir, L / 2)), mul(perp, (bow + o) * 0.75));
	}
	return { d, mid };
}

/**
 * Serialize a smooth path through `pts` with unit tangents `tans` (cubic
 * Hermite: each segment's handles run along the end tangents, 40% of the
 * segment length up to `maxHandle`) — strands sharing a tangent at a point run
 * parallel there.
 */
function hermitePath(pts: P[], tans: P[], maxHandle: number): { d: string; c2: P } {
	const chain: P[] = [pts[0]!];
	let c2: P = pts[0]!;
	for (let i = 0; i + 1 < pts.length; i++) {
		const a = pts[i]!;
		const b = pts[i + 1]!;
		const h = Math.min(len(sub(b, a)) * 0.4, maxHandle);
		c2 = sub(b, mul(tans[i + 1]!, h));
		chain.push(add(a, mul(tans[i]!, h)), c2, b);
	}
	return { d: cubicPath(chain), c2 };
}

interface Gate {
	/** gate point, outward tangent, lane axis */
	at: P;
	t: P;
	p: P;
	/** strands through this gate: [edge index, strand, sort key] */
	uses: Array<{ e: number; s: number; key: number }>;
	/** lane offset per `${e}:${s}` */
	lane: Map<string, number>;
	/** distinct near endpoints — a tie only marks real convergence (>= 2) */
	ends: Set<string>;
}

interface Trunk {
	/** hub indices, lo < hi; the lane axis `p` is fixed for the lo → hi direction */
	lo: number;
	hi: number;
	from: P;
	to: P;
	d: P;
	p: P;
	/** cable-tie distance from each hub along the trunk */
	reach: number;
	uses: Array<{ e: number; s: number; key: number }>;
	lane: Map<string, number>;
	count: number;
}

/** Strands pinch to this fraction of their lane offset at a cable-tie. */
const PINCH = 0.4;

/**
 * Group `groups` (cluster discs) into super-groups for the overview backbone:
 * k-means (farthest-point seeded, so deterministic) over the disc centres, one
 * hub per super-group nudged off any disc into open space, hubs joined by a
 * minimum spanning tree plus shortcuts where the tree detours a lot. Computed
 * once per layout; `bundleEdges` routes along it. Fewer than 6 groups → no hubs.
 */
export function buildBackbone(
	groups: ReadonlyArray<{ id: string; x: number; y: number; R: number }>,
	opts: { hubs?: number; margin?: number } = {},
): Backbone {
	const G = groups.length;
	const empty: Backbone = { hubs: [], links: [], next: [], hubOf: new Map() };
	if (G < 6) return empty;
	const K = Math.min(G, opts.hubs ?? Math.max(2, Math.min(12, Math.round(Math.sqrt(G / 2)))));
	const margin = opts.margin ?? 30;
	let cx = 0;
	let cy = 0;
	for (const g of groups) {
		cx += g.x / G;
		cy += g.y / G;
	}
	// Farthest-point seeding from the group farthest out.
	const centres: P[] = [];
	let first = 0;
	groups.forEach((g, i) => {
		if (Math.hypot(g.x - cx, g.y - cy) > Math.hypot(groups[first]!.x - cx, groups[first]!.y - cy)) first = i;
	});
	centres.push({ x: groups[first]!.x, y: groups[first]!.y });
	const minD = groups.map((g) => Math.hypot(g.x - centres[0]!.x, g.y - centres[0]!.y));
	while (centres.length < K) {
		let best = 0;
		for (let i = 1; i < G; i++) if (minD[i]! > minD[best]!) best = i;
		const c = { x: groups[best]!.x, y: groups[best]!.y };
		centres.push(c);
		groups.forEach((g, i) => (minD[i] = Math.min(minD[i]!, Math.hypot(g.x - c.x, g.y - c.y))));
	}
	const assign = new Array<number>(G).fill(0);
	for (let it = 0; it < 12; it++) {
		let moved = false;
		groups.forEach((g, i) => {
			let best = 0;
			let bd = Infinity;
			centres.forEach((c, k) => {
				const d = Math.hypot(g.x - c.x, g.y - c.y);
				if (d < bd) {
					bd = d;
					best = k;
				}
			});
			if (assign[i] !== best) moved = true;
			assign[i] = best;
		});
		const acc = centres.map(() => ({ x: 0, y: 0, n: 0 }));
		groups.forEach((g, i) => {
			const a = acc[assign[i]!]!;
			a.x += g.x;
			a.y += g.y;
			a.n++;
		});
		acc.forEach((a, k) => {
			if (a.n > 0) centres[k] = { x: a.x / a.n, y: a.y / a.n };
		});
		if (!moved && it > 0) break;
	}
	// Hubs sit in open space: push each off any disc it lands on.
	const hubs = centres.map((c) => ({ ...c }));
	for (let pass = 0; pass < 6; pass++) {
		for (const h of hubs) {
			for (const g of groups) {
				const v = sub(h, g);
				const d = len(v);
				if (d < g.R + margin) {
					const u = d > 1e-6 ? mul(v, 1 / d) : { x: 1, y: 0 };
					h.x = g.x + u.x * (g.R + margin);
					h.y = g.y + u.y * (g.R + margin);
				}
			}
		}
	}
	// Minimum spanning tree (Prim) over the hubs.
	const dist = (i: number, j: number): number => Math.hypot(hubs[i]!.x - hubs[j]!.x, hubs[i]!.y - hubs[j]!.y);
	const links: Array<[number, number]> = [];
	const inTree = new Set<number>([0]);
	while (inTree.size < K) {
		let bi = -1;
		let bj = -1;
		let bd = Infinity;
		for (const i of inTree) {
			for (let j = 0; j < K; j++) {
				if (inTree.has(j)) continue;
				const d = dist(i, j);
				if (d < bd) {
					bd = d;
					bi = i;
					bj = j;
				}
			}
		}
		links.push([Math.min(bi, bj), Math.max(bi, bj)]);
		inTree.add(bj);
	}
	// Shortest paths (Floyd–Warshall) over tree + shortcuts.
	const INF = Infinity;
	const sp = (ls: Array<[number, number]>): { D: number[][]; next: number[][] } => {
		const D = Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i === j ? 0 : INF)));
		const next = Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i === j ? j : -1)));
		for (const [i, j] of ls) {
			D[i]![j] = D[j]![i] = dist(i, j);
			next[i]![j] = j;
			next[j]![i] = i;
		}
		for (let k = 0; k < K; k++)
			for (let i = 0; i < K; i++)
				for (let j = 0; j < K; j++)
					if (D[i]![k]! + D[k]![j]! < D[i]![j]!) {
						D[i]![j] = D[i]![k]! + D[k]![j]!;
						next[i]![j] = next[i]![k]!;
					}
		return { D, next };
	};
	const tree = sp(links);
	// A shortcut where the tree path is more than twice the straight distance.
	for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) if (tree.D[i]![j]! > 2 * dist(i, j)) links.push([i, j]);
	const { next } = links.length > K - 1 ? sp(links) : tree;
	const hubOf = new Map<string, number>();
	groups.forEach((g, i) => hubOf.set(g.id, assign[i]!));
	return { hubs, links, next, hubOf };
}

/**
 * Route `edges` as bundles. Edges whose groups differ and sit apart leave each
 * group through a sector gate and run gate → gate (or, with a backbone and ends
 * in different super-groups, gate → hub trunk path → gate); same-group edges
 * and edges between touching groups draw as gently bowed curves.
 */
export function bundleEdges(edges: readonly BundleInput[], opts: BundleOptions = {}): BundleResult {
	const gap = opts.gap ?? 3;
	const gateFrac = opts.gateFrac ?? 0.85;
	const tieMin = opts.tieMin ?? 3;
	const sectors = opts.sectors ?? 16;
	const arrowSize = opts.arrowSize ?? 7;
	const trunkWidth = opts.trunkWidth ?? gap * 10;
	const tiePad = opts.tiePad ?? gap;
	const bb = opts.backbone && opts.backbone.hubs.length > 1 ? opts.backbone : null;
	const paths = new Map<string, string>();
	const mids = new Map<string, P>();
	const ties: Tie[] = [];
	const trunkLabels: BundleResult["trunks"] = [];
	const gates = new Map<string, Gate>();
	const trunks = new Map<string, Trunk>();
	const step = (Math.PI * 2) / sectors;

	const gateFor = (end: BundleEnd, toward: P): Gate => {
		const ang = Math.atan2(toward.y - end.gy, toward.x - end.gx);
		const sector = ((Math.round(ang / step) % sectors) + sectors) % sectors;
		const k = `${end.group}\u0000${sector}`;
		let g = gates.get(k);
		if (!g) {
			const t: P = { x: Math.cos(sector * step), y: Math.sin(sector * step) };
			g = { at: add({ x: end.gx, y: end.gy }, mul(t, end.gR * gateFrac)), t, p: { x: -t.y, y: t.x }, uses: [], lane: new Map(), ends: new Set() };
			gates.set(k, g);
		}
		return g;
	};
	const trunkFor = (i: number, j: number): Trunk => {
		const lo = Math.min(i, j);
		const hi = Math.max(i, j);
		const k = `${lo}:${hi}`;
		let t = trunks.get(k);
		if (!t) {
			const from = bb!.hubs[lo]!;
			const to = bb!.hubs[hi]!;
			const d = unit(sub(to, from));
			t = { lo, hi, from, to, d, p: { x: -d.y, y: d.x }, reach: Math.min(len(sub(to, from)) * 0.2, 140), uses: [], lane: new Map(), count: 0 };
			trunks.set(k, t);
		}
		return t;
	};
	const hubPath = (a: number, b: number): number[] | null => {
		const out = [a];
		let cur = a;
		while (cur !== b) {
			cur = bb!.next[cur]?.[b] ?? -1;
			if (cur < 0 || out.length > bb!.hubs.length) return null;
			out.push(cur);
		}
		return out;
	};
	/** Lateral position of `pt` seen from `from`, on lane axis `p` (−1…1). */
	const lateral = (pt: P, from: P, p: P): number => {
		const v = sub(pt, from);
		return (v.x * p.x + v.y * p.y) / (len(v) || 1);
	};

	/** The points a strand passes along hub path `hp`: per trunk, pinched at the
	 * tie by each hub and at full lane offset (`laneOf`) mid-run. */
	const trunkPoints = (hp: number[], laneOf: (t: Trunk) => number): Array<{ at: P; dir: P; t: Trunk }> => {
		const out: Array<{ at: P; dir: P; t: Trunk }> = [];
		for (let k = 0; k + 1 < hp.length; k++) {
			const t = trunkFor(hp[k]!, hp[k + 1]!);
			const fwd = hp[k] === t.lo;
			const dir = fwd ? t.d : mul(t.d, -1);
			const o = laneOf(t);
			const a = fwd ? t.from : t.to;
			const b = fwd ? t.to : t.from;
			out.push(
				{ at: add(add(a, mul(dir, t.reach)), mul(t.p, o * PINCH)), dir, t },
				{ at: add(mul(add(a, b), 0.5), mul(t.p, o)), dir, t },
				{ at: add(sub(b, mul(dir, t.reach)), mul(t.p, o * PINCH)), dir, t },
			);
		}
		return out;
	};
	/** How far `pt` lies ahead of `from` along `dir`. */
	const ahead = (pt: P, from: P, dir: P): number => (pt.x - from.x) * dir.x + (pt.y - from.y) * dir.y;

	// Pass 1: classify, register gate/trunk uses (sorted later by where they head).
	/** hp = hub path; [i0, i1] = the trunk points the strand actually passes */
	type Route = { gA: Gate; gB: Gate; hp: number[] | null; i0: number; i1: number };
	const routed: Array<Route | null> = edges.map((e, i) => {
		const span = Math.hypot(e.b.gx - e.a.gx, e.b.gy - e.a.gy) - (e.a.gR + e.b.gR) * gateFrac;
		if (e.a.group === e.b.group || span < 30) return null;
		const u: P = { x: e.a.x, y: e.a.y };
		const v: P = { x: e.b.x, y: e.b.y };
		const hp =
			bb && e.a.hub !== undefined && e.b.hub !== undefined && (e.a.hub !== e.b.hub || e.viaHub) ? hubPath(e.a.hub, e.b.hub) : null;
		if (hp && hp.length === 1) {
			// Same super-group, via its hub: converge on the hub and fan back out.
			const h = bb!.hubs[hp[0]!]!;
			const gA = gateFor(e.a, h);
			const gB = gateFor(e.b, h);
			gA.uses.push({ e: i, s: 0, key: lateral(v, gA.at, gA.p) });
			gB.uses.push({ e: i, s: 0, key: lateral(u, gB.at, gB.p) });
			gA.ends.add(`${e.a.x},${e.a.y}`);
			gB.ends.add(`${e.b.x},${e.b.y}`);
			return { gA, gB, hp, i0: 0, i1: -1 };
		}
		if (hp) {
			// A group sitting past the path's first (last) points joins it further
			// in rather than doubling back to the tie (no hairpins).
			const tp = trunkPoints(hp, () => 0);
			const cA: P = { x: e.a.gx, y: e.a.gy };
			const cB: P = { x: e.b.gx, y: e.b.gy };
			let i0 = 0;
			let i1 = tp.length - 1;
			while (i0 < i1 && ahead(tp[i0]!.at, cA, tp[i0]!.dir) < 0) i0++;
			while (i1 > i0 && ahead(cB, tp[i1]!.at, tp[i1]!.dir) < 0) i1--;
			const gA = gateFor(e.a, tp[i0]!.at);
			const gB = gateFor(e.b, tp[i1]!.at);
			const used = new Set(tp.slice(i0, i1 + 1).map((q) => q.t));
			for (let k = 0; k + 1 < hp.length; k++) {
				const t = trunkFor(hp[k]!, hp[k + 1]!);
				if (!used.has(t)) continue;
				t.count += e.weight ?? 1;
				// Ends on the trunk's lo / hi side: order lanes by where strands come from and go.
				const fwd = hp[k] === t.lo;
				const loEnd = fwd ? u : v;
				const hiEnd = fwd ? v : u;
				const key = lateral(loEnd, t.from, t.p) + lateral(hiEnd, t.to, t.p);
				t.uses.push({ e: i, s: 0, key });
			}
			// One strand per edge on the backbone (the trunk label carries the count).
			gA.uses.push({ e: i, s: 0, key: lateral(v, gA.at, gA.p) });
			gB.uses.push({ e: i, s: 0, key: lateral(u, gB.at, gB.p) });
			gA.ends.add(`${e.a.x},${e.a.y}`);
			gB.ends.add(`${e.b.x},${e.b.y}`);
			return { gA, gB, hp, i0, i1 };
		}
		const gA = gateFor(e.a, { x: e.b.gx, y: e.b.gy });
		const gB = gateFor(e.b, { x: e.a.gx, y: e.a.gy });
		gA.ends.add(`${e.a.x},${e.a.y}`);
		gB.ends.add(`${e.b.x},${e.b.y}`);
		for (let s = 0; s < e.strands; s++) {
			// Order across a gate by where the strand ends up on the far side.
			gA.uses.push({ e: i, s, key: lateral(v, gA.at, gA.p) + s * 1e-6 });
			gB.uses.push({ e: i, s, key: lateral(u, gB.at, gB.p) + s * 1e-6 });
		}
		return { gA, gB, hp: null, i0: 0, i1: 0 };
	});

	// Pass 2: lanes per gate and trunk; cable-ties where enough strands pinch.
	let bundles = 0;
	const tie = (at: P, p: P, m: number, lg: number): void => {
		const half = ((m - 1) / 2) * lg * PINCH + tiePad;
		ties.push({ x1: at.x - p.x * half, y1: at.y - p.y * half, x2: at.x + p.x * half, y2: at.y + p.y * half });
	};
	for (const g of gates.values()) {
		g.uses.sort((x, y) => x.key - y.key);
		const m = g.uses.length;
		const lg = Math.min(gap, trunkWidth / Math.max(1, m));
		g.uses.forEach((u, i) => g.lane.set(`${u.e}:${u.s}`, (i - (m - 1) / 2) * lg));
		if (m >= 2) bundles++;
		if (m >= tieMin && g.ends.size >= 2) tie(g.at, g.p, m, lg);
	}
	for (const t of trunks.values()) {
		t.uses.sort((x, y) => x.key - y.key);
		const m = t.uses.length;
		const lg = Math.min(gap, trunkWidth / Math.max(1, m));
		t.uses.forEach((u, i) => t.lane.set(`${u.e}:${u.s}`, (i - (m - 1) / 2) * lg));
		bundles++;
		if (m >= tieMin) {
			tie(add(t.from, mul(t.d, t.reach)), t.p, m, lg);
			tie(sub(t.to, mul(t.d, t.reach)), t.p, m, lg);
		}
		if (t.count >= 2) {
			const mid = mul(add(t.from, t.to), 0.5);
			trunkLabels.push({ ...add(mid, mul(t.p, ((m - 1) / 2) * lg + tiePad * 3)), count: t.count });
		}
	}

	// Pass 3: paths.
	edges.forEach((e, i) => {
		const r = routed[i];
		if (!r) {
			const offs = Array.from({ length: e.strands }, (_, k) => (k - (e.strands - 1) / 2) * gap);
			const bowSign = e.key.length % 2 === 0 ? 1 : -1;
			const { d, mid } = plainCurve(e.a, e.b, offs, bowSign, e.arrow ? arrowSize : 0);
			paths.set(e.key, d);
			mids.set(e.key, mid);
			return;
		}
		const { gA, gB, hp } = r;
		const u: P = { x: e.a.x, y: e.a.y };
		const v: P = { x: e.b.x, y: e.b.y };
		let d = "";
		if (hp) {
			const A1 = add(gA.at, mul(gA.p, (gA.lane.get(`${i}:0`) ?? 0) * PINCH));
			const B1 = add(gB.at, mul(gB.p, (gB.lane.get(`${i}:0`) ?? 0) * PINCH));
			const tp = trunkPoints(hp, (t) => t.lane.get(`${i}:0`) ?? 0).slice(r.i0, r.i1 + 1);
			const pts = tp.map((q) => q.at);
			const tans = tp.map((q) => q.dir);
			if (hp.length === 1) {
				pts.push(bb!.hubs[hp[0]!]!);
				tans.push(unit(sub(B1, A1)));
			}
			const u0 = trim(u, e.a.r + 1, A1);
			const v0 = trim(v, e.b.r + 3, B1);
			pts.unshift(u0, A1);
			// At a gate: between the gate's outward normal and the way on.
			const blend = (a: P, b: P): P => (len(add(a, b)) > 0.5 ? unit(add(a, b)) : b);
			tans.unshift(unit(sub(A1, u0)), blend(gA.t, unit(sub(pts[2]!, A1))));
			pts.push(B1, v0);
			tans.push(blend(mul(gB.t, -1), unit(sub(B1, pts[pts.length - 3]!))), unit(sub(v0, B1)));
			const { d: sd, c2 } = hermitePath(pts, tans, gap * 50);
			d += sd;
			if (e.arrow) d += chevron(v0, c2, arrowSize);
			// The trunk carries the count label; no per-edge mid.
			paths.set(e.key, d);
			return;
		}
		const Lm = Math.min(len(sub(gB.at, gA.at)) * 0.4, 600);
		let mid: P = { x: 0, y: 0 };
		for (let s = 0; s < e.strands; s++) {
			const oA = gA.lane.get(`${i}:${s}`) ?? 0;
			const oB = gB.lane.get(`${i}:${s}`) ?? 0;
			const A1 = add(gA.at, mul(gA.p, oA * PINCH)); // pinched at the tie…
			const B1 = add(gB.at, mul(gB.p, oB * PINCH));
			const u0 = trim(u, e.a.r + 1, A1);
			const v0 = trim(v, e.b.r + 3, B1);
			const L1 = Math.min(len(sub(A1, u0)) * 0.55, 160);
			const L2 = Math.min(len(sub(v0, B1)) * 0.55, 160);
			const pts: P[] = [
				u0,
				add(u0, mul(sub(A1, u0), 0.35)),
				sub(A1, mul(gA.t, L1)),
				A1,
				// …side by side (full lane gap) along the gate tangents between ties.
				add(add(A1, mul(gA.t, Lm)), mul(gA.p, oA * 0.6)),
				add(add(B1, mul(gB.t, Lm)), mul(gB.p, oB * 0.6)),
				B1,
				sub(B1, mul(gB.t, L2)),
				add(v0, mul(sub(B1, v0), 0.35)),
				v0,
			];
			d += cubicPath(pts);
			if (e.arrow) d += chevron(v0, pts[8]!, arrowSize);
			mid = add(mul(add(A1, B1), 0.5), mul(add(gA.t, gB.t), Lm * 0.375));
		}
		paths.set(e.key, d);
		mids.set(e.key, mid);
	});
	return { paths, mids, ties, trunks: trunkLabels, bundles };
}

/** Straight path (while the layout is still moving, or with bundling off). */
export function straightPath(a: BundleEnd, b: BundleEnd, arrow = 0): string {
	const s = trim({ x: a.x, y: a.y }, a.r + 1, b);
	const e = trim({ x: b.x, y: b.y }, b.r + 3, a);
	return `M${f(s.x)},${f(s.y)}L${f(e.x)},${f(e.y)}${arrow > 0 ? chevron(e, s, arrow) : ""}`;
}
