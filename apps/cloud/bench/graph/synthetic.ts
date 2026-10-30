// Deterministic synthetic vault graphs for the graph-view bench + UI e2e
// (never real vault data). Shape mimics a product vault: domains as the spine,
// features/stories/specs/tasks `part_of` a domain (stories/tasks often via a
// feature), plus local cross-links (realizes, governs, depends_on, …).
import type { Edge, GraphNode, GraphPayload } from "@brainz/contracts";

// Mulberry32 — tiny seeded PRNG so every run builds the same graph.
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const MIX: [string, number][] = [
	["feature", 0.16],
	["story", 0.16],
	["spec", 0.14],
	["task", 0.2],
	["decision", 0.08],
	["workflow", 0.06],
	["constraint", 0.06],
	["pattern", 0.04],
	["glossary", 0.04],
	["concept", 0.06],
];

/** A synthetic graph of `n` concepts (~n/40 domains, ~3.5 edges per concept). */
export function syntheticGraph(n: number, seed = 42): GraphPayload {
	const rand = rng(seed + n);
	const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
	const domainCount = Math.max(3, Math.round(n / 40));
	const nodes: GraphNode[] = [];
	const edges: Edge[] = [];
	const domains: string[] = [];
	for (let i = 0; i < domainCount; i++) {
		const id = `domain-${i}`;
		domains.push(id);
		nodes.push({ id, title: `Domain ${i}`, type: "domain", tags: [], degree: 0 });
	}
	// Per-domain member lists so cross-links stay mostly local (realistic).
	const byDomain = new Map<string, string[]>(domains.map((d) => [d, []]));
	const features = new Map<string, string[]>(domains.map((d) => [d, []]));
	for (let i = nodes.length; i < n; i++) {
		let r = rand();
		let type = "concept";
		for (const [t, w] of MIX) {
			if ((r -= w) <= 0) {
				type = t;
				break;
			}
		}
		const id = `${type}-${i}`;
		const domain = pick(domains);
		nodes.push({ id, title: `${type[0]!.toUpperCase()}${type.slice(1)} ${i}`, type, tags: [], degree: 0 });
		const feats = features.get(domain)!;
		// Stories/tasks hang off a feature when the domain has one (2-level part_of).
		const parent = (type === "story" || type === "task") && feats.length > 0 && rand() < 0.7 ? pick(feats) : domain;
		edges.push({ from: id, to: parent, relation: "part_of" });
		if (type === "feature") feats.push(id);
		const local = byDomain.get(domain)!;
		const extra = Math.floor(rand() * 4);
		for (let k = 0; k < extra && local.length > 0; k++) {
			const other = rand() < 0.85 ? pick(local) : nodes[Math.floor(rand() * nodes.length)]!.id;
			if (other === id) continue;
			edges.push({ from: id, to: other, relation: pick(["realizes", "governs", "depends_on", "references", "related_to"]) });
		}
		local.push(id);
	}
	// Dedupe (same from|relation|to) and compute degrees.
	const seen = new Set<string>();
	const deduped = edges.filter((e) => {
		const k = `${e.from}|${e.relation}|${e.to}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	const deg = new Map<string, number>();
	for (const e of deduped) {
		deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
		deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
	}
	for (const node of nodes) node.degree = deg.get(node.id) ?? 0;
	return { nodes, edges: deduped };
}
