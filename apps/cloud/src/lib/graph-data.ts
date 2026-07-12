// Pure graph-view data helpers — ported from packages/web/frontend/graph-data.ts
// (same semantics; unit-tested in graph-data.test.ts).

import type { ConceptTypeEntry, Edge, GraphNode, GraphPayload } from "@brainz/contracts";
import { BUILTIN_CONCEPT_TYPES, PENDING_TYPE_COLOR } from "@brainz/contracts";

/** Node fill palette by concept type — Obsidian-inspired, violet-forward.
 *
 * These are the DEFAULT (built-in) colors; the live palette is the vault's
 * per-vault type registry (Wave TR), which seeds from exactly these values.
 * The full TWELVE-category palette lives as CSS custom properties in
 * src/app.css (--node-*); keep these hexes in sync with those tokens and with
 * BUILTIN_CONCEPT_TYPES in @brainz/contracts:
 *   concept #a78bfa · feature #34d399 · decision #fbbf24 ·
 *   constraint #f87171 · pattern #22d3ee · glossary #f472b6 ·
 *   domain #60a5fa · workflow #fb923c · story #a3e635 · spec #2dd4bf ·
 *   task #f59e0b · pending #6b7280 (gray, rendered dashed). */
export const TYPE_COLORS: Record<string, string> = {
  ...Object.fromEntries(BUILTIN_CONCEPT_TYPES.map((t) => [t.key, t.color])),
  pending: PENDING_TYPE_COLOR,
};
export const ALL_TYPES = Object.keys(TYPE_COLORS);

/**
 * Resolve a color map (type key → hex) from a vault's type registry, falling
 * back to the built-in palette when no registry is supplied (or a key is
 * absent). Always includes `pending`. The graph, chips, and panels render
 * colors through this so custom types get a color and re-coloring a type in
 * settings takes effect everywhere.
 */
export function typeColorsFromRegistry(
  registry?: readonly ConceptTypeEntry[] | null,
): Record<string, string> {
  if (!registry || registry.length === 0) return TYPE_COLORS;
  const out: Record<string, string> = { pending: PENDING_TYPE_COLOR };
  for (const t of registry) out[t.key] = t.color;
  return out;
}

/** Look up a type's color from a resolved map, defaulting to the pending gray. */
export function colorForType(type: string, colors: Record<string, string>): string {
  return colors[type] ?? colors["pending"] ?? PENDING_TYPE_COLOR;
}

/** Node radius grows with degree (same curve as packages/web). */
export const radiusFor = (degree: number): number => 6 + Math.sqrt(degree) * 2.4;

/** Undirected adjacency map over the edge list. */
export function adjacency(edges: Edge[]): Map<string, Set<string>> {
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
export function neighborhood(edges: Edge[], rootId: string, depth: number): Set<string> {
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
  const keep = (n: GraphNode): boolean => {
    if (opts.types && !opts.types.has(n.type)) return false;
    if (opts.focus && !opts.focus.has(n.id)) return false;
    return true;
  };
  const nodes = graph.nodes.filter(keep);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}
