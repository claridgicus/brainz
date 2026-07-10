import type { ConceptMeta, Edge, RelatedNode, RelatedOptions } from "./types.js";

/**
 * BFS over edges (both directions) from `startId` up to `opts.depth`
 * (default 1, clamped to 1..3). Deterministic: neighbors are visited in
 * (id, relation) order; results are sorted by distance, then id. Nodes with
 * no meta (pending concepts, i.e. broken-link targets) are traversed but
 * never returned. `opts.limit` applies after that filter. Returns [] when
 * `startId` itself has no meta.
 */
export function bfsRelated(
  edges: Edge[],
  startId: string,
  opts: RelatedOptions,
  getMeta: (id: string) => ConceptMeta | null,
): RelatedNode[] {
  const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
  if (!getMeta(startId)) return [];

  const allowed = opts.relations ? new Set(opts.relations) : null;
  const allEdges = edges.filter((e) => !allowed || allowed.has(e.relation));

  // BFS over edges in both directions.
  const visited = new Map<string, { distance: number; via: Edge[] }>();
  visited.set(startId, { distance: 0, via: [] });
  let frontier = [startId];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const curInfo = visited.get(cur)!;
      const neighbors: { node: string; edge: Edge }[] = [];
      for (const e of allEdges) {
        if (e.from === cur) neighbors.push({ node: e.to, edge: e });
        if (e.to === cur) neighbors.push({ node: e.from, edge: e });
      }
      neighbors.sort(
        (x, y) => x.node.localeCompare(y.node) || x.edge.relation.localeCompare(y.edge.relation),
      );
      for (const { node, edge } of neighbors) {
        if (visited.has(node)) continue;
        visited.set(node, { distance: d, via: [...curInfo.via, edge] });
        next.push(node);
      }
    }
    frontier = next;
  }

  const out: RelatedNode[] = [];
  for (const [nodeId, info] of visited) {
    if (nodeId === startId) continue;
    const meta = getMeta(nodeId);
    if (!meta) continue; // pending concept (broken link target)
    out.push({ concept: meta, distance: info.distance, via: info.via });
  }
  out.sort((x, y) => x.distance - y.distance || x.concept.id.localeCompare(y.concept.id));
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}
