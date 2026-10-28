/**
 * Pure helpers for VaultDO — no Cloudflare imports so vitest can run them in
 * Node. Storage/orchestration lives in vault-do.ts; ranking/traversal/parsing
 * come from @brainz/engine; these are the cloud-specific shims: wire-shape
 * compaction, the LIKE/token keyword-search fallback, and the graph payload
 * (same shape as packages/web's /api/graph, owned by @brainz/contracts).
 */
import type { GraphNode, GraphPayload, ToolConceptMeta } from "@brainz/contracts";
import type { ConceptMeta, Edge } from "@brainz/engine";

/** Synthetic filePath for engine types / MCP outputs — the cloud has no files. */
export function syntheticFilePath(id: string): string {
  return `concepts/${id}.md`;
}

/** Compact concept metadata as the wire shapes emit it (no filePath). */
export function compactMeta(meta: ConceptMeta): ToolConceptMeta {
  return {
    id: meta.id,
    title: meta.title,
    type: meta.type,
    status: meta.status,
    ...(meta.product !== undefined ? { product: meta.product } : {}),
    tags: meta.tags,
    ...(meta.codeAreas !== undefined ? { codeAreas: meta.codeAreas } : {}),
    ...(meta.taskStatus !== undefined ? { taskStatus: meta.taskStatus } : {}),
    ...(meta.takenBy !== undefined ? { takenBy: meta.takenBy } : {}),
    ...(meta.takenAt !== undefined ? { takenAt: meta.takenAt } : {}),
    ...(meta.doneAt !== undefined ? { doneAt: meta.doneAt } : {}),
  };
}

// ------------------------------------------------- embedding rate cap

/**
 * Is the vault at/over its rolling-window embedding cap? `timestamps` are the
 * epoch-ms times of prior embed calls; only those within `windowMs` of `now`
 * count. Returns true once `<count within window> >= cap` — i.e. the next call
 * would exceed the cap and must be skipped. Pure so it unit-tests without a DO.
 */
export function isEmbedRateLimited(
  timestamps: number[],
  now: number,
  windowMs: number,
  cap: number,
): boolean {
  const cutoff = now - windowMs;
  let count = 0;
  for (const t of timestamps) if (t > cutoff) count++;
  return count >= cap;
}

// ------------------------------------------------------- claim staleness

/**
 * Is a `taken` claim stale — held longer than the TTL and thus reclaimable?
 * `takenAt` is an ISO instant (or null/undefined for a task never taken).
 * A missing/unparseable `takenAt` is NOT stale (fail closed: don't reclaim a
 * task we can't reason about). Pure + deterministic (caller passes `now`).
 */
export function isClaimStale(
  takenAt: string | null | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (!takenAt) return false;
  const t = Date.parse(takenAt);
  if (Number.isNaN(t)) return false;
  return now - t >= ttlMs;
}

// ------------------------------------------------------- keyword fallback

/** Tokenize a query the same way core does before FTS (letters/digits/underscore). */
export function tokenize(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 32).map((t) => t.toLowerCase());
}

export interface KeywordDoc {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

/**
 * Token-based keyword score for the no-FTS5 fallback: per matched term,
 * title occurrences weigh 3, tag matches 2, body occurrences 1 (capped so a
 * single spammy doc can't run away). 0 when no term matches.
 */
export function keywordScore(terms: string[], doc: KeywordDoc): number {
  if (terms.length === 0) return 0;
  const title = doc.title.toLowerCase();
  const body = doc.body.toLowerCase();
  const tags = doc.tags.map((t) => t.toLowerCase());
  let score = 0;
  for (const term of terms) {
    score += 3 * countOccurrences(title, term);
    score += 2 * tags.filter((t) => t.includes(term)).length;
    score += Math.min(countOccurrences(body, term), 5);
  }
  return score;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && count < 100) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Flatten + trim a body into a snippet (mirrors core's makeSnippet). */
export function makeSnippet(body: string, maxLen = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

/** Snippet centered on the first term match (fallback keyword mode). */
export function matchSnippet(body: string, terms: string[], maxLen = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (first === -1 || idx < first)) first = idx;
  }
  if (first === -1 || flat.length <= maxLen) return makeSnippet(flat, maxLen);
  const start = Math.max(0, first - Math.floor(maxLen / 4));
  const slice = flat.slice(start, start + maxLen);
  return `${start > 0 ? "…" : ""}${slice}${start + maxLen < flat.length ? "…" : ""}`;
}

// ---------------------------------------------------------------- graph

/**
 * Build the graph payload — one node per concept plus a "pending" node for
 * every edge endpoint with no concept. Verbatim semantics of packages/web's
 * buildGraph (degree counts every touching edge; self-loops once).
 */
export function buildGraphPayload(concepts: ConceptMeta[], edges: Edge[]): GraphPayload {
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

/** Header every Worker → DO call carries, so the DO knows which vault (and owner) it is. */
export const VAULT_ID_HEADER = "x-brainz-vault-id";
