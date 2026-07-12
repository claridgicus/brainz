/**
 * Zod schemas for the engine's domain types (SPEC.md contract).
 *
 * These mirror `@brainz/engine`'s TypeScript types exactly — compile-time
 * assertions below fail the build if either side drifts. Wire-shape schemas
 * (MCP tools, REST API, CLI --json) compose these.
 */
import type {
  Concept,
  ConceptMeta,
  ConceptStatus,
  ConceptType,
  ContextBundle,
  Edge,
  RelatedNode,
  SearchHit,
  TaskStatus,
  VaultStats,
} from "@brainz/engine";
import { z } from "zod";

// Re-export the domain types so wire-shape consumers need only @brainz/contracts.
export type {
  Concept,
  ConceptMeta,
  ConceptStatus,
  ConceptType,
  ContextBundle,
  Edge,
  RelatedNode,
  SearchHit,
  TaskStatus,
  VaultStats,
} from "@brainz/engine";

export const CONCEPT_TYPES = [
  "concept",
  "domain",
  "feature",
  "story",
  "spec",
  "workflow",
  "task",
  "decision",
  "constraint",
  "pattern",
  "glossary",
] as const satisfies readonly ConceptType[];

export const TASK_STATUSES = [
  "open",
  "taken",
  "done",
] as const satisfies readonly TaskStatus[];

/**
 * Canonical relation names — documented conventions, not an enum: relations
 * stay free-form strings on the wire. `part_of` hangs features/stories/
 * workflows off domains, `realized_by` maps a story to the features that
 * deliver it, and `governs` points a spec at what it constrains.
 */
export const CANONICAL_RELATIONS = [
  "part_of",
  "realized_by",
  "realizes",
  "governs",
  "governed_by",
  "depends_on",
  "constrains",
  "supersedes",
  "related_to",
] as const;

export const CONCEPT_STATUSES = [
  "active",
  "draft",
  "deprecated",
] as const satisfies readonly ConceptStatus[];

// ---------------------------------------------------------------------------
// Per-vault concept-type registry (Wave TR).
//
// Concept types are DATA, not a hardcoded enum: each vault owns a registry of
// types (key, label, color, weight, order, hidden) seeded on first init with
// the 11 built-ins below — their CURRENT graph colors and weights that mirror
// today's semantic-zoom signal ranking. `CONCEPT_TYPES` stays the DEFAULT set /
// the TS `ConceptType` union (the ontology onboarding still teaches); the
// RUNTIME validation of a concept's `type` is registry-based (see the VaultDO):
// an unknown/removed type falls back to `concept`, matching prior behavior.
//
// WEIGHT is the single knob that drives the graph's semantic-zoom LOD (higher
// weight = higher signal = revealed earlier / at lower zoom), the chip order,
// the default-visible set, and node sizing. The seed weights below reproduce
// today's signal ranking EXACTLY: domain (rank 0) highest; feature/spec/
// constraint (rank 1); story/workflow/pattern/decision (rank 2); glossary/
// concept/task (rank 3) lowest.
// ---------------------------------------------------------------------------

/** A single concept-type registry entry (seed shape: key/label/color/weight). */
export interface ConceptTypeSeed {
  key: string;
  label: string;
  color: string;
  weight: number;
}

/**
 * The 11 built-in concept types, in canonical order, with their CURRENT graph
 * colors (mirror src/app.css `--node-*` + graph-data TYPE_COLORS) and weights
 * mirroring the semantic-zoom signal ranking. Seeded verbatim into every
 * vault's registry so a fresh/backfilled vault behaves identically to today.
 *
 * Weight tiers (higher = higher signal, revealed earlier):
 *   100  domain
 *    80  feature, spec, constraint
 *    60  story, workflow, pattern, decision
 *    40  glossary, concept, task
 */
export const BUILTIN_CONCEPT_TYPES: readonly ConceptTypeSeed[] = [
  { key: "concept", label: "Concept", color: "#a78bfa", weight: 40 },
  { key: "domain", label: "Domain", color: "#60a5fa", weight: 100 },
  { key: "feature", label: "Feature", color: "#34d399", weight: 80 },
  { key: "story", label: "Story", color: "#a3e635", weight: 60 },
  { key: "spec", label: "Spec", color: "#2dd4bf", weight: 80 },
  { key: "workflow", label: "Workflow", color: "#fb923c", weight: 60 },
  { key: "task", label: "Task", color: "#f59e0b", weight: 40 },
  { key: "decision", label: "Decision", color: "#fbbf24", weight: 60 },
  { key: "constraint", label: "Constraint", color: "#f87171", weight: 80 },
  { key: "pattern", label: "Pattern", color: "#22d3ee", weight: 60 },
  { key: "glossary", label: "Glossary", color: "#f472b6", weight: 40 },
] as const;

/** The `pending` pseudo-type color (edge targets with no concept yet). Not a
 * registry entry (never user-editable) but consumers need its color/weight. */
export const PENDING_TYPE_COLOR = "#6b7280";
/** Weight of the `pending` pseudo-type: below every real type (revealed last). */
export const PENDING_TYPE_WEIGHT = 20;

/** Slugify a user-supplied type key: lowercase, non-alnum → single dash. */
export function slugifyTypeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One concept-type registry entry as it crosses the wire / lands in the UI. */
export const conceptTypeEntrySchema = z
  .object({
    /** Stable slug key stored on concepts (e.g. "feature", "risk"). */
    key: z.string().min(1),
    /** Human-facing label shown on chips / settings. */
    label: z.string().min(1),
    /** Node/chip fill color (any CSS color; hex in the seed). */
    color: z.string().min(1),
    /** Semantic-zoom weight: higher = higher signal, revealed earlier + larger. */
    weight: z.number(),
    /** Explicit sort order for chips / settings (ascending). */
    order: z.number().int(),
    /** Hidden from the graph + chips (built-ins are hidden, never deleted). */
    hidden: z.boolean(),
    /** True for the 11 seeded types: re-weightable/hideable, not hard-deletable. */
    builtin: z.boolean(),
  })
  .strict();
export type ConceptTypeEntry = z.infer<typeof conceptTypeEntrySchema>;

export const conceptTypeListSchema = z
  .object({ types: z.array(conceptTypeEntrySchema) })
  .strict();
export type ConceptTypeList = z.infer<typeof conceptTypeListSchema>;

/** POST /api/vaults/:id/types body — create a custom type. */
export const conceptTypeCreateRequestSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    color: z.string().min(1),
    weight: z.number().optional(),
    order: z.number().int().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();
export type ConceptTypeCreateRequest = z.infer<typeof conceptTypeCreateRequestSchema>;

/** PATCH /api/vaults/:id/types/:key body — edit any type (built-in or custom). */
export const conceptTypeUpdateRequestSchema = z
  .object({
    label: z.string().min(1).optional(),
    color: z.string().min(1).optional(),
    weight: z.number().optional(),
    order: z.number().int().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();
export type ConceptTypeUpdateRequest = z.infer<typeof conceptTypeUpdateRequestSchema>;

export const SEARCH_MODES = ["hybrid", "keyword", "semantic"] as const;

/**
 * Vault embedding availability, as reported by stats/reindex surfaces.
 * - `ready`        — the embedding model answered and vectors are stored.
 * - `unavailable`  — no AI binding, or a call failed; search is keyword-only.
 * - `rate-limited` — the per-vault rolling-hour embed cap was hit, so embeds
 *   are skipped and search degrades to keyword-only until the window clears.
 */
export const EMBEDDING_STATUSES = ["ready", "unavailable", "rate-limited"] as const;

export const conceptTypeSchema = z.enum(CONCEPT_TYPES);
export const conceptStatusSchema = z.enum(CONCEPT_STATUSES);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const searchModeSchema = z.enum(SEARCH_MODES);
export const embeddingStatusSchema = z.enum(EMBEDDING_STATUSES);

export type SearchMode = z.infer<typeof searchModeSchema>;
export type EmbeddingStatus = z.infer<typeof embeddingStatusSchema>;

export const edgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    relation: z.string(),
  })
  .strict();

/** Full concept metadata as the local vault emits it (includes absolute filePath). */
export const conceptMetaSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: conceptTypeSchema,
    status: conceptStatusSchema,
    product: z.string().optional(),
    tags: z.array(z.string()),
    codeAreas: z.array(z.string()).optional(),
    taskStatus: taskStatusSchema.optional(),
    takenBy: z.string().optional(),
    takenAt: z.string().optional(),
    doneAt: z.string().optional(),
    filePath: z.string(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict();

export const conceptSchema = conceptMetaSchema.extend({ body: z.string() });

export const searchHitSchema = z
  .object({
    concept: conceptMetaSchema,
    score: z.number(),
    snippet: z.string(),
  })
  .strict();

export const relatedNodeSchema = z
  .object({
    concept: conceptMetaSchema,
    distance: z.number().int(),
    via: z.array(edgeSchema),
  })
  .strict();

export const contextBundleSchema = z
  .object({
    markdown: z.string(),
    included: z.array(conceptMetaSchema),
    truncated: z.boolean(),
    approxTokens: z.number(),
  })
  .strict();

export const vaultStatsSchema = z
  .object({
    concepts: z.number().int(),
    edges: z.number().int(),
    products: z.array(z.string()),
    tags: z.array(z.string()),
    byType: z.record(z.string(), z.number()),
    onboarded: z.boolean(),
    openTasks: z.number().int(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Compile-time drift guards: each schema's inferred type must stay mutually
// assignable with the engine type it encodes. Pure type-level — no runtime cost.
// ---------------------------------------------------------------------------

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

type _EdgeInSync = Expect<MutuallyAssignable<z.infer<typeof edgeSchema>, Edge>>;
type _ConceptMetaInSync = Expect<MutuallyAssignable<z.infer<typeof conceptMetaSchema>, ConceptMeta>>;
type _ConceptInSync = Expect<MutuallyAssignable<z.infer<typeof conceptSchema>, Concept>>;
type _SearchHitInSync = Expect<MutuallyAssignable<z.infer<typeof searchHitSchema>, SearchHit>>;
type _RelatedNodeInSync = Expect<MutuallyAssignable<z.infer<typeof relatedNodeSchema>, RelatedNode>>;
type _ContextBundleInSync = Expect<
  MutuallyAssignable<z.infer<typeof contextBundleSchema>, ContextBundle>
>;
type _VaultStatsInSync = Expect<MutuallyAssignable<z.infer<typeof vaultStatsSchema>, VaultStats>>;
type _ConceptTypeCovered = Expect<
  MutuallyAssignable<(typeof CONCEPT_TYPES)[number], ConceptType>
>;
type _ConceptStatusCovered = Expect<
  MutuallyAssignable<(typeof CONCEPT_STATUSES)[number], ConceptStatus>
>;
type _TaskStatusCovered = Expect<
  MutuallyAssignable<(typeof TASK_STATUSES)[number], TaskStatus>
>;
