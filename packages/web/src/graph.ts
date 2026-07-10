import type { ConceptMeta, ConceptType, Edge } from "@brainz/core";

/** Node in the /api/graph payload. Pending nodes are edge targets with no
 * concept file yet — they get `type: "pending"` and `pending: true`. */
export interface GraphNode {
  id: string;
  title: string;
  type: ConceptType | "pending";
  product?: string;
  tags: string[];
  degree: number;
  pending?: true;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: Edge[];
}

/** Build the graph payload: one node per concept plus one "pending" node for
 * every edge endpoint that doesn't resolve to a concept. Degree counts every
 * edge touching the node (self-loops count once). */
export function buildGraph(concepts: ConceptMeta[], edges: Edge[]): GraphPayload {
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const e of edges) {
    bump(e.from);
    if (e.to !== e.from) bump(e.to);
  }

  const known = new Set(concepts.map((c) => c.id));
  const nodes: GraphNode[] = concepts.map((c) => ({
    id: c.id,
    title: c.title,
    type: c.type,
    ...(c.product !== undefined ? { product: c.product } : {}),
    tags: c.tags,
    degree: degree.get(c.id) ?? 0,
  }));

  const pendingIds = new Set<string>();
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!known.has(id)) pendingIds.add(id);
    }
  }
  for (const id of [...pendingIds].sort()) {
    nodes.push({
      id,
      title: id,
      type: "pending",
      tags: [],
      degree: degree.get(id) ?? 0,
      pending: true,
    });
  }

  return { nodes, edges };
}
