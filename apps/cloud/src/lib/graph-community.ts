// Deterministic community detection for the cloud graph workspace (pure, no
// DOM): concepts that link to each other group together regardless of type.
// Louvain modularity optimisation over the undirected, weighted edge graph,
// seeded with each concept's `part_of` root so domains anchor communities when
// the links agree. No randomness: nodes are visited in id order and ties break
// on the lowest community index, so the same graph always yields the same
// communities (and the cached layout never reshuffles on reload). See
// SPEC-CLOUD.md ("Graph workspace — level of detail, clusters").
import type { Edge, GraphNode } from "@brainz/contracts";

/** Edge weight of a `part_of` link (other relations weigh 1): hierarchy is a strong grouping signal. */
export const PART_OF_WEIGHT = 2;
/** Communities smaller than this merge into the neighbour community they link to most. */
export const MIN_COMMUNITY = 3;

/** Undirected weighted adjacency over node indexes 0..n-1 (self-loops allowed in aggregated levels). */
interface WGraph {
	n: number;
	/** per node: neighbour index → weight (self-loop weight counted once) */
	adj: Array<Map<number, number>>;
}

function addEdge(g: WGraph, a: number, b: number, w: number): void {
	g.adj[a]!.set(b, (g.adj[a]!.get(b) ?? 0) + w);
	if (a !== b) g.adj[b]!.set(a, (g.adj[b]!.get(a) ?? 0) + w);
}

/**
 * One Louvain level: local moving from `init` until no node improves modularity
 * (resolution `gamma`). Returns a dense community index per node.
 */
function localMoving(g: WGraph, init: Int32Array, gamma: number): Int32Array {
	const { n, adj } = g;
	const k = new Float64Array(n);
	let m2 = 0;
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (const [j, w] of adj[i]!) s += j === i ? 2 * w : w;
		k[i] = s;
		m2 += s;
	}
	const comm = Int32Array.from(init);
	if (m2 === 0) return renumber(comm);
	const tot = new Float64Array(n);
	for (let i = 0; i < n; i++) tot[comm[i]!] += k[i]!;
	const wTo = new Float64Array(n);
	const touched: number[] = [];
	for (let pass = 0; pass < 32; pass++) {
		let moved = false;
		for (let i = 0; i < n; i++) {
			const ci = comm[i]!;
			const ki = k[i]!;
			// Weights from i to each neighbouring community.
			for (const [j, w] of adj[i]!) {
				if (j === i) continue;
				const cj = comm[j]!;
				if (wTo[cj] === 0) touched.push(cj);
				wTo[cj] += w;
			}
			tot[ci] -= ki;
			let best = ci;
			let bestGain = wTo[ci]! - (gamma * tot[ci]! * ki) / m2;
			for (const c of touched) {
				const gain = wTo[c]! - (gamma * tot[c]! * ki) / m2;
				if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best && best !== ci)) {
					best = c;
					bestGain = gain;
				}
			}
			tot[best] += ki;
			if (best !== ci) {
				comm[i] = best;
				moved = true;
			}
			for (const c of touched) wTo[c] = 0;
			wTo[ci] = 0;
			touched.length = 0;
		}
		if (!moved) break;
	}
	return renumber(comm);
}

/** Relabel community ids densely, in order of first appearance (deterministic). */
function renumber(comm: Int32Array): Int32Array {
	const map = new Map<number, number>();
	const out = new Int32Array(comm.length);
	for (let i = 0; i < comm.length; i++) {
		let c = map.get(comm[i]!);
		if (c === undefined) map.set(comm[i]!, (c = map.size));
		out[i] = c;
	}
	return out;
}

/** Full multi-level Louvain. `seed` = initial community per node (defaults to singletons). */
function louvain(g: WGraph, gamma = 1, seed?: Int32Array): Int32Array {
	let level = g;
	let assign = new Int32Array(g.n).map((_, i) => i); // original node → current level node
	let init = seed ? renumber(seed) : new Int32Array(g.n).map((_, i) => i);
	for (let depth = 0; depth < 16; depth++) {
		const comm = localMoving(level, init, gamma);
		const count = Math.max(-1, ...comm) + 1;
		for (let i = 0; i < assign.length; i++) assign[i] = comm[assign[i]!]!;
		if (count === level.n) break; // nothing merged: converged
		// Aggregate: one node per community, edge weights summed (internal → self-loop).
		const next: WGraph = { n: count, adj: Array.from({ length: count }, () => new Map()) };
		for (let i = 0; i < level.n; i++) {
			for (const [j, w] of level.adj[i]!) {
				if (j < i) continue;
				addEdge(next, comm[i]!, comm[j]!, w);
			}
		}
		level = next;
		init = new Int32Array(count).map((_, i) => i);
	}
	return renumber(assign);
}

export interface Community {
	/** member concept ids, sorted */
	members: string[];
	/** the most central concept: a domain if the community has one, else the best-connected member */
	head: string;
}

export interface CommunityResult {
	communities: Community[];
	/** concepts with no edges at all (sorted) — the caller groups them as "loose" */
	loose: string[];
}

/**
 * Group concepts into link communities. Communities never form by type: a
 * concept lands with whatever it links to. Groups under MIN_COMMUNITY that link
 * outward join their most strongly linked neighbour community; concepts
 * with no edges at all are returned as `loose`. Communities over `maxSize` are
 * re-split by Louvain at a higher resolution, then into BFS-ordered chunks.
 */
export function detectCommunities(nodes: readonly GraphNode[], edges: readonly Edge[], maxSize = 400): CommunityResult {
	const ids = nodes.map((n) => n.id).sort();
	const idx = new Map(ids.map((id, i) => [id, i]));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const g: WGraph = { n: ids.length, adj: ids.map(() => new Map()) };
	const parent = new Map<number, number>();
	// Edges in a stable order so weights (and thus ties) never depend on input order.
	const sorted = [...edges].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : a.relation < b.relation ? -1 : 1));
	for (const e of sorted) {
		const a = idx.get(e.from);
		const b = idx.get(e.to);
		if (a === undefined || b === undefined || a === b) continue;
		addEdge(g, a, b, e.relation === "part_of" ? PART_OF_WEIGHT : 1);
		if (e.relation === "part_of" && !parent.has(a)) parent.set(a, b);
	}
	// Seed: each concept starts in its part_of root's community (cycle-safe).
	const seed = new Int32Array(g.n);
	for (let i = 0; i < g.n; i++) {
		let cur = i;
		const seen = new Set([cur]);
		for (let d = 0; d < 16; d++) {
			const p = parent.get(cur);
			if (p === undefined || seen.has(p)) break;
			seen.add(p);
			cur = p;
		}
		seed[i] = cur;
	}
	const comm = louvain(g, 1, seed);

	const loose: string[] = [];
	const groups = new Map<number, number[]>();
	for (let i = 0; i < g.n; i++) {
		if (g.adj[i]!.size === 0) {
			loose.push(ids[i]!);
			continue;
		}
		let list = groups.get(comm[i]!);
		if (!list) groups.set(comm[i]!, (list = []));
		list.push(i);
	}
	// Near-isolated groups (a lone concept, or a pair hanging off something
	// bigger) join the community they link to most, smallest first. A group with
	// no outside links (its own tiny component) stays as it is.
	const small = [...groups.entries()]
		.filter(([, list]) => list.length < MIN_COMMUNITY)
		.sort((a, b) => a[1].length - b[1].length || a[0] - b[0]);
	for (const [c, list] of small) {
		if (!groups.has(c)) continue;
		const w = new Map<number, number>();
		for (const i of list)
			for (const [j, wt] of g.adj[i]!) {
				const cj = comm[j]!;
				if (cj !== c && groups.has(cj)) w.set(cj, (w.get(cj) ?? 0) + wt);
			}
		let best = -1;
		let bw = 0;
		for (const [cj, wt] of w) if (wt > bw || (wt === bw && cj < best)) [best, bw] = [cj, wt];
		if (best < 0) continue;
		const into = groups.get(best)!;
		for (const i of list) {
			into.push(i);
			comm[i] = best;
		}
		groups.delete(c);
	}

	const internalDegree = (members: readonly number[]): Map<number, number> => {
		const set = new Set(members);
		const out = new Map<number, number>();
		for (const i of members) {
			let s = 0;
			for (const [j, w] of g.adj[i]!) if (j !== i && set.has(j)) s += w;
			out.set(i, s);
		}
		return out;
	};
	const headOf = (members: readonly number[]): number => {
		const deg = internalDegree(members);
		const score = (i: number): [number, number, number] => [byId.get(ids[i]!)?.type === "domain" ? 1 : 0, deg.get(i) ?? 0, g.adj[i]!.size];
		let best = members[0]!;
		for (const i of members) {
			const [a1, a2, a3] = score(i);
			const [b1, b2, b3] = score(best);
			if (a1 > b1 || (a1 === b1 && (a2 > b2 || (a2 === b2 && (a3 > b3 || (a3 === b3 && ids[i]! < ids[best]!)))))) best = i;
		}
		return best;
	};
	// Split oversized communities: Louvain on the induced subgraph at doubled
	// resolution; if that doesn't break it up, BFS-ordered chunks (neighbours stay together).
	const split = (members: number[], gamma: number, depth: number): number[][] => {
		if (members.length <= maxSize) return [members];
		if (depth < 4) {
			const local = new Map(members.map((m, i) => [m, i]));
			const sub: WGraph = { n: members.length, adj: members.map(() => new Map()) };
			for (const m of members)
				for (const [j, w] of g.adj[m]!) {
					const lj = local.get(j);
					if (lj !== undefined && j > m) addEdge(sub, local.get(m)!, lj, w);
				}
			const sc = louvain(sub, gamma * 2);
			const parts = new Map<number, number[]>();
			members.forEach((m, i) => {
				let p = parts.get(sc[i]!);
				if (!p) parts.set(sc[i]!, (p = []));
				p.push(m);
			});
			if (parts.size > 1) return [...parts.values()].flatMap((p) => split(p, gamma * 2, depth + 1));
		}
		const set = new Set(members);
		const order: number[] = [];
		const seen = new Set<number>();
		for (const start of [headOf(members), ...members]) {
			if (seen.has(start)) continue;
			const queue = [start];
			seen.add(start);
			while (queue.length) {
				const v = queue.shift()!;
				order.push(v);
				const nbrs = [...g.adj[v]!.keys()].filter((j) => set.has(j) && !seen.has(j)).sort((a, b) => a - b);
				for (const j of nbrs) {
					seen.add(j);
					queue.push(j);
				}
			}
		}
		const out: number[][] = [];
		for (let c = 0; c < order.length; c += maxSize) out.push(order.slice(c, c + maxSize));
		return out;
	};

	const communities: Community[] = [];
	for (const list of groups.values()) {
		for (const part of split(list, 1, 0)) {
			communities.push({ members: part.map((i) => ids[i]!).sort(), head: ids[headOf(part)]! });
		}
	}
	communities.sort((a, b) => b.members.length - a.members.length || (a.head < b.head ? -1 : 1));
	return { communities, loose };
}
