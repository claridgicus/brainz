/**
 * CLI `--json` output shapes, exactly as `brainz <cmd> --json` prints them
 * today. Where the CLI emits engine domain values verbatim (search, related,
 * context) these are just the domain schemas from ./domain.js.
 */
import { z } from "zod";
import {
  conceptSchema,
  contextBundleSchema,
  embeddingStatusSchema,
  relatedNodeSchema,
  searchHitSchema,
  vaultStatsSchema,
} from "./domain.js";

/** `brainz search <query> --json` → SearchHit[] (full metas, incl. filePath). */
export const cliSearchJsonSchema = z.array(searchHitSchema);
export type CliSearchJson = z.infer<typeof cliSearchJsonSchema>;

/** One neighbor row in `brainz show --json`; `title: null` → pending concept. */
export const cliShowNeighborSchema = z
  .object({
    direction: z.enum(["out", "in"]),
    relation: z.string(),
    id: z.string(),
    title: z.string().nullable(),
  })
  .strict();
export type CliShowNeighbor = z.infer<typeof cliShowNeighborSchema>;

/** `brainz show <id> --json` → the full Concept plus its edge-level neighbors. */
export const cliShowJsonSchema = conceptSchema.extend({
  neighbors: z.array(cliShowNeighborSchema),
});
export type CliShowJson = z.infer<typeof cliShowJsonSchema>;

/** `brainz related <id> --json` → RelatedNode[]. */
export const cliRelatedJsonSchema = z.array(relatedNodeSchema);
export type CliRelatedJson = z.infer<typeof cliRelatedJsonSchema>;

/** `brainz context --json` → the full ContextBundle. */
export const cliContextJsonSchema = contextBundleSchema;
export type CliContextJson = z.infer<typeof cliContextJsonSchema>;

export const cliValidationIssueSchema = z
  .object({
    message: z.string(),
    /** File path relative to the vault dir, when the issue maps to one file. */
    file: z.string().optional(),
  })
  .strict();
export type CliValidationIssue = z.infer<typeof cliValidationIssueSchema>;

/** `brainz validate --json` → the validation report (ok === no errors). */
export const cliValidateJsonSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(cliValidationIssueSchema),
    warnings: z.array(cliValidationIssueSchema),
    concepts: z.number().int(),
    edges: z.number().int(),
  })
  .strict();
export type CliValidateJson = z.infer<typeof cliValidateJsonSchema>;

/** `brainz reindex --json` → VaultStats plus `embeddingStatus`. */
export const cliReindexJsonSchema = vaultStatsSchema.extend({
  embeddingStatus: embeddingStatusSchema,
});
export type CliReindexJson = z.infer<typeof cliReindexJsonSchema>;
