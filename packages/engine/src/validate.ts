import type { Edge } from "./types.js";

export interface GraphIssue {
  message: string;
}

export interface GraphValidation {
  errors: GraphIssue[];
  warnings: GraphIssue[];
}

/**
 * Validate a concept graph.
 *
 * Errors: duplicate concept ids.
 * Warnings: edges pointing at ids with no concept ("pending" concepts per
 * SPEC — wiki-links to unknown ids are allowed, never errors).
 */
export function validateGraph(concepts: { id: string }[], edges: Edge[]): GraphValidation {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];

  const counts = new Map<string, number>();
  for (const concept of concepts) {
    counts.set(concept.id, (counts.get(concept.id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > 1) errors.push({ message: `duplicate id "${id}" in ${n} concepts` });
  }

  for (const edge of edges) {
    if (!counts.has(edge.to)) {
      warnings.push({
        message: `broken link: ${edge.from} —${edge.relation}→ ${edge.to} (no such concept; treated as pending)`,
      });
    }
  }

  return { errors, warnings };
}
