// ---- types (exact contract per SPEC.md) ----

export type ConceptType =
  | "concept"
  | "domain"
  | "feature"
  | "story"
  | "spec"
  | "workflow"
  | "decision"
  | "constraint"
  | "pattern"
  | "glossary";

export type ConceptStatus = "active" | "draft" | "deprecated";

export interface ConceptMeta {
  id: string;
  title: string;
  type: ConceptType;
  status: ConceptStatus;
  product?: string;
  tags: string[];
  /** Rough paths/globs where this knowledge lives in the codebase (frontmatter `code_areas`). */
  codeAreas?: string[];
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
}
