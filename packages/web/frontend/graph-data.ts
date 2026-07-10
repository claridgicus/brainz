// Pure graph-view data helpers (no DOM) — unit-tested in test/graph-data.test.ts.

import type { ApiEdge, ApiNode, GraphPayload } from "./types.js";

/** Undirected adjacency map over the edge list. */
export function adjacency(edges: ApiEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    let set = adj.get(a);
    if (!set) adj.set(a, (set = new Set()));
    set.add(b);
  };
  for (const e of edges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return adj;
}

/** Ids within `depth` undirected hops of `rootId` (root included). */
export function neighborhood(edges: ApiEdge[], rootId: string, depth: number): Set<string> {
  const adj = adjacency(edges);
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nbr of adj.get(id) ?? []) {
        if (!seen.has(nbr)) {
          seen.add(nbr);
          next.push(nbr);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

export interface FilterOptions {
  /** Node types to keep ("pending" counts as a type). Undefined = keep all. */
  types?: Set<string>;
  /** If set, only nodes in this set survive (focus mode). */
  focus?: Set<string> | null;
}

/** Apply type + focus filters; edges survive only if both endpoints do. */
export function filterGraph(graph: GraphPayload, opts: FilterOptions): GraphPayload {
  const keep = (n: ApiNode): boolean => {
    if (opts.types && !opts.types.has(n.type)) return false;
    if (opts.focus && !opts.focus.has(n.id)) return false;
    return true;
  };
  const nodes = graph.nodes.filter(keep);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}
