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

export const SEARCH_MODES = ["hybrid", "keyword", "semantic"] as const;

/** Vault embedding availability, as reported by stats/reindex surfaces. */
export const EMBEDDING_STATUSES = ["ready", "unavailable"] as const;

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
