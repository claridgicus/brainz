// ---- types (exact contract per SPEC.md) ----

export type ConceptType =
  | "concept"
  | "domain"
  | "feature"
  | "story"
  | "spec"
  | "workflow"
  | "task"
  | "decision"
  | "constraint"
  | "pattern"
  | "glossary";

export type ConceptStatus = "active" | "draft" | "deprecated";

/**
 * Lifecycle of a `task`-type concept (distinct from ConceptStatus). A task
 * concept with no taskStatus is treated as "open". Threaded through frontmatter
 * as `task_status` / `taken_by` / `taken_at` / `done_at`.
 */
export type TaskStatus = "open" | "taken" | "done";

export interface ConceptMeta {
  id: string;
  title: string;
  type: ConceptType;
  status: ConceptStatus;
  product?: string;
  tags: string[];
  /** Rough paths/globs where this knowledge lives in the codebase (frontmatter `code_areas`). */
  codeAreas?: string[];
  /** Task lifecycle (only meaningful for `task`-type concepts). Absent ⇒ "open". */
  taskStatus?: TaskStatus;
  /** Free-form label of the agent/orchestrator that claimed the task. */
  takenBy?: string;
  /** ISO timestamp when the task was claimed. */
  takenAt?: string;
  /** ISO timestamp when the task was completed. */
  doneAt?: string;
  filePath: string; // absolute path
  createdAt?: string; // ISO dates from frontmatter if present
  updatedAt?: string;
}

export interface Concept extends ConceptMeta {
  body: string; // markdown body sans frontmatter
}

export interface Edge {
  from: string;
  to: string;
  relation: string;
}

export interface SearchOptions {
  query: string;
  mode?: "hybrid" | "keyword" | "semantic"; // default "hybrid"
  product?: string;
  tags?: string[];
  type?: ConceptType;
  limit?: number; // default 10
}

export interface SearchHit {
  concept: ConceptMeta;
  score: number;
  snippet: string;
}

export interface RelatedOptions {
  depth?: number; // default 1, max 3
  limit?: number;
  relations?: string[];
}

export interface RelatedNode {
  concept: ConceptMeta;
  distance: number;
  via: Edge[];
}

export interface ContextOptions {
  query?: string; // seed via search…
  ids?: string[]; // …or explicit seeds (at least one of query/ids)
  product?: string;
  depth?: number; // default 1
  tokenBudget?: number; // default 4000; approx tokens = chars/4
}

export interface ContextBundle {
  markdown: string; // assembled, ready to inject into an agent prompt
  included: ConceptMeta[];
  truncated: boolean;
  approxTokens: number;
}

export interface UpsertInput {
  id?: string;
  title: string;
  body: string;
  type?: ConceptType;
  status?: ConceptStatus;
  product?: string;
  tags?: string[];
  /** Rough paths/globs where this knowledge lives in the codebase (written as frontmatter `code_areas`). */
  codeAreas?: string[];
  /** Task lifecycle for `task`-type concepts (frontmatter `task_status`). */
  taskStatus?: TaskStatus;
  /** Free-form label of the claimer (frontmatter `taken_by`). */
  takenBy?: string;
  /** ISO claim timestamp (frontmatter `taken_at`). */
  takenAt?: string;
  /** ISO completion timestamp (frontmatter `done_at`). */
  doneAt?: string;
  relations?: Record<string, string[]>;
}

export interface VaultStats {
  concepts: number;
  edges: number;
  products: string[];
  tags: string[];
  byType: Record<string, number>;
  /** Whether the vault has been onboarded (product knowledge indexed via the onboard flow). */
  onboarded: boolean;
  /** Count of open (untaken) `task`-type concepts. */
  openTasks: number;
}
