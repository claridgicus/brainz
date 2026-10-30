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
}

export interface BundleInput {
	key: string;
	a: BundleEnd;
	b: BundleEnd;
	/** parallel strands to draw (1, or min(weight, cap) for an aggregated edge) */
	strands: number;
	/** draw an arrowhead chevron at the `b` end (typed relations) */
	arrow?: boolean;
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
	bundles: number;
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

interface Gate {
	/** gate point, outward tangent, lane axis */
	at: P;
	t: P;
	p: P;
	/** strands through this gate: [edge index, strand, sort key] */
	uses: Array<{ e: number; s: number; key: number }>;
	/** lane offset per `${e}:${s}` */
	lane: Map<string, number>;
}

/**
 * Route `edges` as bundles. Edges whose groups differ and sit apart leave each
 * group through a sector gate and run gate → gate; same-group edges and edges
 * between touching groups draw as gently bowed curves.
 */
export function bundleEdges(edges: readonly BundleInput[], opts: BundleOptions = {}): BundleResult {
	const gap = opts.gap ?? 3;
	const gateFrac = opts.gateFrac ?? 0.85;
	const tieMin = opts.tieMin ?? 3;
	const sectors = opts.sectors ?? 16;
	const arrowSize = opts.arrowSize ?? 7;
	const paths = new Map<string, string>();
	const mids = new Map<string, P>();
	const ties: Tie[] = [];
	const gates = new Map<string, Gate>();
	const step = (Math.PI * 2) / sectors;

	const gateFor = (end: BundleEnd, toward: BundleEnd): Gate => {
		const ang = Math.atan2(toward.gy - end.gy, toward.gx - end.gx);
		const sector = ((Math.round(ang / step) % sectors) + sectors) % sectors;
		const k = `${end.group}\u0000${sector}`;
		let g = gates.get(k);
		if (!g) {
			const t: P = { x: Math.cos(sector * step), y: Math.sin(sector * step) };
			g = { at: add({ x: end.gx, y: end.gy }, mul(t, end.gR * gateFrac)), t, p: { x: -t.y, y: t.x }, uses: [], lane: new Map() };
			gates.set(k, g);
		}
		return g;
	};

	// Pass 1: classify, register gate uses (sorted later by where they head).
	const routed: Array<{ e: BundleInput; gA: Gate; gB: Gate } | null> = edges.map((e, i) => {
		const span = Math.hypot(e.b.gx - e.a.gx, e.b.gy - e.a.gy) - (e.a.gR + e.b.gR) * gateFrac;
		if (e.a.group === e.b.group || span < 30) return null;
		const gA = gateFor(e.a, e.b);
		const gB = gateFor(e.b, e.a);
		for (let s = 0; s < e.strands; s++) {
			// Order across a gate by where the strand ends up on the far side.
			const farA = sub({ x: e.b.x, y: e.b.y }, gA.at);
			const farB = sub({ x: e.a.x, y: e.a.y }, gB.at);
			gA.uses.push({ e: i, s, key: (farA.x * gA.p.x + farA.y * gA.p.y) / (len(farA) || 1) + s * 1e-6 });
			gB.uses.push({ e: i, s, key: (farB.x * gB.p.x + farB.y * gB.p.y) / (len(farB) || 1) + s * 1e-6 });
		}
		return { e, gA, gB };
	});

	// Pass 2: lanes per gate.
	let bundles = 0;
	for (const g of gates.values()) {
		g.uses.sort((x, y) => x.key - y.key);
		const m = g.uses.length;
		const lg = Math.min(gap, (gap * 12) / Math.max(1, m));
		g.uses.forEach((u, i) => g.lane.set(`${u.e}:${u.s}`, (i - (m - 1) / 2) * lg));
		if (m >= 2) bundles++;
		if (m >= tieMin) {
			const half = ((m - 1) / 2) * lg * 0.4 + lg;
			ties.push({
				x1: g.at.x - g.p.x * half,
				y1: g.at.y - g.p.y * half,
				x2: g.at.x + g.p.x * half,
				y2: g.at.y + g.p.y * half,
			});
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
		const { gA, gB } = r;
		const u: P = { x: e.a.x, y: e.a.y };
		const v: P = { x: e.b.x, y: e.b.y };
		const Lm = Math.min(len(sub(gB.at, gA.at)) * 0.4, 600);
		let d = "";
		let mid: P = { x: 0, y: 0 };
		for (let s = 0; s < e.strands; s++) {
			const oA = gA.lane.get(`${i}:${s}`) ?? 0;
			const oB = gB.lane.get(`${i}:${s}`) ?? 0;
			const A1 = add(gA.at, mul(gA.p, oA * 0.4)); // pinched at the tie…
			const B1 = add(gB.at, mul(gB.p, oB * 0.4));
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
	return { paths, mids, ties, bundles };
}

/** Straight path (while the layout is still moving, or with bundling off). */
export function straightPath(a: BundleEnd, b: BundleEnd, arrow = 0): string {
	const s = trim({ x: a.x, y: a.y }, a.r + 1, b);
	const e = trim({ x: b.x, y: b.y }, b.r + 3, a);
	return `M${f(s.x)},${f(s.y)}L${f(e.x)},${f(e.y)}${arrow > 0 ? chevron(e, s, arrow) : ""}`;
}
