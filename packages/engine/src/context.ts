import type { Concept, ConceptMeta, ContextBundle, Edge } from "./types.js";

/**
 * Data source for context assembly. Lookups are synchronous so both a
 * sync sqlite-backed caller and an async D1-backed caller can drive this:
 * an async caller preloads its (vault-scoped) concepts/edges into maps and
 * passes map lookups here — the ranking/budget/truncation logic lives in
 * this module exactly once.
 */
export interface ContextSource {
  /** All edges of the graph (traversed in both directions). */
  edges: Edge[];
  getMeta(id: string): ConceptMeta | null;
  getConcept(id: string): Concept | null;
}

export interface AssembleContextOptions {
  /** Graph expansion depth from the seeds. Default 1 (0 = seeds only). */
  depth?: number;
  /** Approx token budget (chars / 4). Default 4000. */
  tokenBudget?: number;
  /** When set, expanded (non-seed) concepts of another product are excluded. */
  product?: string;
}

/**
 * Assemble a markdown context bundle from ordered seed ids.
 *
 * Seeds keep their given order (deduped; ids without meta are dropped).
 * The graph is expanded to `depth`; each layer is added in sorted-id order
 * (deterministic). Pending nodes are traversed but never included. Sections
 * (`## <title> (<id>)`) are emitted in rank order until the token budget
 * would be exceeded; `truncated` is set if anything was cut. Sections whose
 * concept carries `codeAreas` end with a "Code areas: …" line so the briefed
 * agent knows both the knowledge AND where in the codebase to apply it.
 */
export function assembleContext(
  seedIds: string[],
  source: ContextSource,
  opts: AssembleContextOptions = {},
): ContextBundle {
  const depth = Math.max(opts.depth ?? 1, 0);
  const tokenBudget = opts.tokenBudget ?? 4000;

  // Seeds: given order, deduped, existing concepts only.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (candidateId: string): void => {
    if (!seen.has(candidateId)) {
      seen.add(candidateId);
      ordered.push(candidateId);
    }
  };
  for (const seedId of seedIds) {
    if (source.getMeta(seedId)) push(seedId);
  }

  // Expand to depth: neighbors ranked by distance, then id (deterministic).
  const allEdges = source.edges;
  const visited = new Set(ordered);
  let frontier = [...ordered];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const layer = new Set<string>();
    for (const cur of frontier) {
      for (const e of allEdges) {
        if (e.from === cur) layer.add(e.to);
        if (e.to === cur) layer.add(e.from);
      }
    }
    const fresh = [...layer].filter((x) => !visited.has(x)).sort();
    frontier = [];
    for (const nodeId of fresh) {
      visited.add(nodeId);
      frontier.push(nodeId);
      const meta = source.getMeta(nodeId);
      if (!meta) continue; // pending concept
      if (opts.product && meta.product !== opts.product) continue;
      push(nodeId);
    }
  }

  // Emit sections until the budget would be exceeded.
  const included: ConceptMeta[] = [];
  const sections: string[] = [];
  let truncated = false;
  let chars = 0;
  for (const conceptId of ordered) {
    const concept = source.getConcept(conceptId);
    if (!concept) continue;
    const codeAreasLine =
      concept.codeAreas && concept.codeAreas.length > 0
        ? `\n\nCode areas: ${concept.codeAreas.map((a) => `\`${a}\``).join(", ")}`
        : "";
    const section = `## ${concept.title} (${concept.id})\n\n${concept.body.trim()}${codeAreasLine}`;
    const addChars = section.length + (sections.length > 0 ? 2 : 0); // "\n\n" separator
    if (Math.ceil((chars + addChars) / 4) > tokenBudget) {
      truncated = true;
      break;
    }
    sections.push(section);
    chars += addChars;
    const { body: _body, ...meta } = concept;
    included.push(meta);
  }

  const markdown = sections.join("\n\n");
  return {
    markdown,
    included,
    truncated,
    approxTokens: Math.ceil(markdown.length / 4),
  };
}
