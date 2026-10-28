/**
 * MCP tool registry — THE source of truth for the Brainz tools.
 *
 * Names, titles, descriptions (the orchestrator-facing UX text), input schemas,
 * and defaults live here, NOT in the servers. `@brainz/mcp-server` (stdio) and
 * the apps/cloud remote MCP build their registrations by iterating `MCP_TOOLS`;
 * handlers stay server-side, keyed by tool name.
 *
 * `outputSchema` encodes the JSON payload each tool actually returns today.
 * It is NOT passed to the MCP SDK (tools respond with plain text blocks, no
 * structuredContent) — it exists so server tests can parse response text with
 * the contract schema, which is the anti-drift guarantee.
 */
import { z } from "zod";
import {
  CONCEPT_STATUSES,
  CONCEPT_TYPES,
  TASK_STATUSES,
  conceptStatusSchema,
  edgeSchema,
  embeddingStatusSchema,
  taskStatusSchema,
  vaultStatsSchema,
} from "./domain.js";

/** Compact concept metadata as MCP tools emit it: no absolute filePath noise.
 * `type` is a registry-resolved string (a key in the vault's concept-type
 * registry), not the strict enum — a concept may carry a custom type. */
export const toolConceptMetaSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    status: conceptStatusSchema,
    product: z.string().optional(),
    tags: z.array(z.string()),
    codeAreas: z.array(z.string()).optional(),
    taskStatus: taskStatusSchema.optional(),
    takenBy: z.string().optional(),
    takenAt: z.string().optional(),
    doneAt: z.string().optional(),
  })
  .strict();

export type ToolConceptMeta = z.infer<typeof toolConceptMetaSchema>;

// ------------------------------------------------------------- input schemas

export const searchConceptsInputSchema = z.object({
  query: z.string().describe("Free-text search query, e.g. \"lead scoring\" or \"session auth\"."),
  mode: z
    .enum(["hybrid", "keyword", "semantic"])
    .default("hybrid")
    .describe("Search mode. \"hybrid\" (default) fuses keyword and semantic ranking; semantic silently falls back to keyword if embeddings are unavailable."),
  product: z.string().optional().describe("Only return concepts belonging to this product."),
  tags: z.array(z.string()).optional().describe("Only return concepts carrying ALL of these tags."),
  type: z.enum(CONCEPT_TYPES).optional().describe("Only return concepts of this type."),
  limit: z.number().int().min(1).max(50).default(10).describe("Max hits to return (default 10)."),
});

export const getConceptInputSchema = z.object({
  id: z.string().describe("Exact concept id (slug), e.g. \"lead-scoring\"."),
});

export const getRelatedInputSchema = z.object({
  id: z.string().describe("Concept id to start from."),
  depth: z.number().int().min(1).max(3).default(1).describe("How many hops to traverse (1-3, default 1)."),
  limit: z.number().int().min(1).optional().describe("Max related nodes to return."),
  relations: z
    .array(z.string())
    .optional()
    .describe("Only follow edges with these relation names, e.g. [\"depends_on\", \"part_of\"]."),
});

export const getContextInputSchema = z.object({
  query: z.string().optional().describe("Search query used to pick seed concepts."),
  ids: z.array(z.string()).optional().describe("Explicit seed concept ids (kept first, in order)."),
  product: z.string().optional().describe("Restrict expansion to concepts of this product."),
  depth: z.number().int().min(0).max(3).default(1).describe("Graph hops to expand from the seeds (default 1)."),
  tokenBudget: z
    .number()
    .int()
    .min(1)
    .default(4000)
    .describe("Approximate token cap for the bundle (chars/4, default 4000)."),
});

export const upsertConceptInputSchema = z.object({
  id: z.string().optional().describe("Concept id (slug). Omit to derive from title; pass an existing id to update."),
  title: z.string().describe("Human-readable title (required, non-empty)."),
  body: z.string().describe("Markdown body. [[other-id]] wiki-links become graph edges."),
  type: z
    .string()
    .optional()
    .describe(
      "Concept type (default \"concept\"). The 11 built-in types are concept, domain, feature, story, spec, workflow, task, decision, constraint, pattern, glossary; a vault may also define custom types. An unknown type falls back to \"concept\".",
    ),
  status: z.enum(CONCEPT_STATUSES).optional().describe("Lifecycle status (default \"active\")."),
  product: z.string().optional().describe("Product grouping key."),
  tags: z.array(z.string()).optional().describe("Tags for filtering."),
  codeAreas: z
    .array(z.string())
    .optional()
    .describe(
      "Rough codebase paths/globs where this knowledge lives, e.g. [\"packages/core/src/vault.ts\", \"apps/web/src/routes/**\"] — lets agents briefed by get_context know where to apply it.",
    ),
  taskStatus: taskStatusSchema
    .optional()
    .describe(
      "For type=\"task\" concepts: lifecycle \"open\" | \"taken\" | \"done\" (default \"open\"). Prefer the task tools (create_task / take_task / complete_task) over setting this directly.",
    ),
  takenBy: z.string().optional().describe("For tasks: label of the agent/orchestrator that claimed it."),
  takenAt: z.string().optional().describe("For tasks: ISO timestamp when claimed."),
  doneAt: z.string().optional().describe("For tasks: ISO timestamp when completed."),
  relations: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe(
      "Typed edges, e.g. {\"depends_on\": [\"auth-system\"]}. Conventions: part_of (feature/story/task → domain), realized_by (story → features), realizes (task → stories/features), governs (spec → what it constrains), governed_by (task → specs), depends_on, constrains, supersedes, related_to. For domain concepts, prefer linking to OTHER domains (related_to / depends_on) wherever they share a boundary or hand off responsibility — connected domains reveal how the product's areas overlap instead of floating as isolated islands.",
    ),
});

export const linkConceptsInputSchema = z.object({
  from: z.string().describe("Source concept id (its file gains the relation)."),
  to: z.string().describe("Target concept id."),
  relation: z
    .string()
    .default("related_to")
    .describe(
      "Edge type, e.g. part_of | realized_by | governs | depends_on | constrains | supersedes | related_to (default). Domain→domain links (related_to / depends_on) are encouraged where two domains share a boundary, so the graph shows how areas overlap.",
    ),
});

export const deleteConceptInputSchema = z.object({
  id: z.string().describe("Exact concept id (slug) to delete, e.g. \"lead-scoring\"."),
});

export const listConceptsInputSchema = z.object({
  product: z.string().optional().describe("Only concepts of this product."),
  type: z.enum(CONCEPT_TYPES).optional().describe("Only concepts of this type."),
  tag: z.string().optional().describe("Only concepts carrying this tag."),
});

export const vaultStatsInputSchema = z.object({});

export const onboardInputSchema = z.object({
  action: z
    .enum(["start", "complete", "status"])
    .describe(
      '"start" returns the onboarding playbook, "complete" marks the vault onboarded (requires `summary`), "status" reports onboarded state and concept counts.',
    ),
  productName: z
    .string()
    .optional()
    .describe("With \"start\": the product's name, echoed into the playbook heading."),
  repoHint: z
    .string()
    .optional()
    .describe("With \"start\": where the codebase lives (path or URL), echoed into the playbook."),
  summary: z
    .string()
    .optional()
    .describe(
      'Required with "complete": 2–5 sentences on what was indexed and any notable gaps — stored as the product-onboarding-summary concept.',
    ),
  areaList: z
    .array(z.string())
    .optional()
    .describe(
      'With "status" or "complete": the repo\'s top-level source areas (packages/*, apps/*/src subtrees, major dirs) from your own repo walk — Brainz can\'t read the repo. "status" diffs concepts\' code_areas against this to report covered vs uncovered areas; "complete" is REJECTED if too many areas are still uncovered.',
    ),
});

export const syncInputSchema = z.object({
  action: z
    .enum(["start", "complete", "status"])
    .describe(
      '"start" returns the sync (re-onboard) playbook — a DRIFT playbook scoped to what changed since the last sync (NOT the full onboarding playbook). "complete" records last_synced_at and appends the summary to the running sync log (requires `summary`). "status" reports onboarded state, last sync time, concept counts, staleness, and (with areaList) coverage.',
    ),
  productName: z
    .string()
    .optional()
    .describe("With \"start\": the product's name, echoed into the playbook heading."),
  summary: z
    .string()
    .optional()
    .describe(
      'Required with "complete": 2–5 sentences on what changed, what you updated, and what you indexed — APPENDED to the product-onboarding-summary concept as a running sync log (never overwritten).',
    ),
  areaList: z
    .array(z.string())
    .optional()
    .describe(
      'With "start", "status", or "complete": the repo\'s top-level source areas from your own repo walk (Brainz can\'t read the repo). Used to compute the coverage map (covered vs uncovered areas) — "complete" is REJECTED if too many areas are still uncovered.',
    ),
  changedPaths: z
    .array(z.string())
    .optional()
    .describe(
      'With "start": paths you found CHANGED since last_synced_at (from your own git diff/log). The playbook focuses the fan-out on the areas these fall under.',
    ),
});

export const sessionHookInputSchema = z.object({
  client: z
    .enum(["claude-code", "other"])
    .optional()
    .describe(
      'Which agent harness you are: "claude-code" for the SessionStart hook steps, "other" for the rules-file (AGENTS.md) steps. Omit to get both.',
    ),
  serverName: z
    .string()
    .optional()
    .describe(
      'The name this MCP server is registered under in your client, echoed into the primer (default "brainz").',
    ),
});

export const dreamInputSchema = z.object({
  action: z
    .enum(["status", "run", "diary", "revert", "configure"])
    .describe(
      '"status" reports whether dreaming is on, its cadence, the last/next dream and any sweep in flight. "run" starts (or continues) a sweep NOW and advances it as far as one request allows. "diary" returns recent Dream Diary entries (newest first). "revert" undoes one dream via its preimages (requires `id`). "configure" turns dreaming on/off and sets the cadence.',
    ),
  id: z.string().optional().describe('With "revert": the dream id to undo (from "diary" or "status").'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('With "diary": how many entries to return (default 10).'),
  enabled: z.boolean().optional().describe('With "configure": turn nightly dreaming on or off.'),
  cadenceHours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .describe('With "configure": hours between dreams (default 24).'),
});

// ------------------------------------------------------------- task tool i/o

export const listTasksInputSchema = z.object({
  taskStatus: taskStatusSchema
    .optional()
    .describe("Only tasks in this lifecycle state (\"open\" | \"taken\" | \"done\"). Omit for all."),
  domain: z
    .string()
    .optional()
    .describe("Only tasks that are part_of this domain concept id."),
});

export const takeTaskInputSchema = z.object({
  id: z
    .string()
    .optional()
    .describe("Claim this specific task by id. Omit to claim THE next open task (oldest by createdAt then id)."),
  takenBy: z
    .string()
    .optional()
    .describe("Label for who's claiming it (agent/orchestrator name). Defaults to a generic label."),
});

export const completeTaskInputSchema = z.object({
  id: z.string().describe("Id of the task to mark done."),
  outcome: z
    .string()
    .describe("A short account of what was done — appended to the task body as an Outcome section."),
});

export const createTaskInputSchema = z.object({
  title: z.string().describe("Human-readable task title (required, non-empty)."),
  body: z.string().describe("Markdown description of the work. [[wiki-links]] become edges."),
  domain: z.string().optional().describe("Domain concept id this task is part_of."),
  realizes: z
    .array(z.string())
    .optional()
    .describe("Story/feature concept ids this task realizes (creates `realizes` edges)."),
  governedBy: z
    .array(z.string())
    .optional()
    .describe("Spec concept ids that govern this task (creates `governed_by` edges)."),
  codeAreas: z
    .array(z.string())
    .optional()
    .describe("Rough codebase paths/globs where the work lands."),
  tags: z.array(z.string()).optional().describe("Tags, e.g. a priority tag like \"high\" or an area tag."),
});

// ------------------------------------------------------------ output schemas

export const searchConceptsOutputSchema = z
  .object({
    /** Present only while the vault is un-onboarded: the one-line onboarding nudge. */
    notice: z.string().optional(),
    hits: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          type: z.string(),
          score: z.number(),
          snippet: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const getConceptOutputSchema = toolConceptMetaSchema.extend({
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  filePath: z.string(),
  body: z.string(),
  neighbors: z.array(
    toolConceptMetaSchema.extend({
      relation: z.string(),
      direction: z.enum(["out", "in"]),
    }),
  ),
});

export const getRelatedOutputSchema = z
  .object({
    id: z.string(),
    related: z.array(
      toolConceptMetaSchema.extend({
        distance: z.number().int(),
        via: z.array(edgeSchema),
      }),
    ),
  })
  .strict();

/**
 * TWO-BLOCK CONVENTION — get_context is the one tool that does not respond
 * with a single JSON text block. Its result has exactly two text content
 * blocks, in order:
 *   1. the assembled markdown briefing (paste straight into a subagent prompt)
 *   2. a single-line JSON footer that parses with get_context's outputSchema:
 *      { included, truncated, approxTokens }
 * Every other tool responds with ONE text block whose JSON parses with its
 * outputSchema — except onboard {action: "start"}, which responds with one
 * markdown text block (see ONBOARD_START_CONTENT).
 */
export const GET_CONTEXT_CONTENT_BLOCKS = ["markdown", "json-footer"] as const;

export const getContextOutputSchema = z
  .object({
    included: z.array(z.string()),
    truncated: z.boolean(),
    approxTokens: z.number(),
  })
  .strict();

export const upsertConceptOutputSchema = toolConceptMetaSchema.extend({
  filePath: z.string(),
});

export const deleteConceptOutputSchema = z
  .object({
    /** True if a concept was removed; false if the id didn't exist (idempotent no-op). */
    deleted: z.boolean(),
    id: z.string(),
  })
  .strict();

export const linkConceptsOutputSchema = z
  .object({
    ok: z.literal(true),
    from: z.string(),
    to: z.string(),
    relation: z.string(),
  })
  .strict();

export const listConceptsOutputSchema = z
  .object({
    count: z.number().int(),
    concepts: z.array(toolConceptMetaSchema),
  })
  .strict();

export const vaultStatsOutputSchema = vaultStatsSchema.extend({
  embeddings: embeddingStatusSchema,
  /** Start of the last completed dream sweep (null if never); absent on hosts without dreaming. */
  lastDreamAt: z.string().nullable().optional(),
});

/**
 * ONBOARD OUTPUT CONVENTION — `onboard {action: "start"}` responds with ONE
 * markdown text block: the playbook itself (the point is to read it, not
 * parse it). "status" and "complete" respond with one JSON text block that
 * parses with the schemas below (encoded together in onboardOutputSchema).
 */
export const ONBOARD_START_CONTENT = "markdown-playbook" as const;

/**
 * Coverage report shape — which reported source areas the vault's concepts
 * cover. Present on `status`/`complete` output only when the caller supplied
 * an `areaList`. The `sync` epic reuses this to report drift.
 */
export const coverageSchema = z
  .object({
    covered: z.array(z.string()),
    uncovered: z.array(z.string()),
    coveragePct: z.number(),
  })
  .strict();

export const onboardStatusOutputSchema = z
  .object({
    onboarded: z.boolean(),
    conceptCount: z.number().int(),
    byType: z.record(z.string(), z.number()),
    // Present only when the caller supplied `areaList`. Covered vs uncovered
    // top-level source areas + coveragePct — the loop's per-iteration signal.
    coverage: coverageSchema.optional(),
  })
  .strict();

export const onboardCompleteOutputSchema = z
  .object({
    ok: z.literal(true),
    onboarded: z.literal(true),
    summaryConceptId: z.string(),
    // Quality signals on the sealed graph — additive; the caller can judge
    // coverage without a second stats round-trip. `complete` refuses when
    // conceptCount would be 0, so these describe a non-empty graph.
    conceptCount: z.number().int(),
    conceptsLackingCodeAreas: z.number().int(),
    hasDomainConcepts: z.boolean(),
    byType: z.record(z.string(), z.number()),
    // Present only when the caller supplied `areaList`: the coverage the
    // graph was sealed at (complete having passed the thin-coverage gate).
    coverage: coverageSchema.optional(),
    // Present only when NO `areaList` was supplied: a note that coverage
    // could not be judged (complete warns rather than hard-blocks).
    coverageNote: z.string().optional(),
  })
  .strict();

export const onboardOutputSchema = z.union([
  onboardCompleteOutputSchema,
  onboardStatusOutputSchema,
]);

/**
 * SYNC OUTPUT CONVENTION — `sync {action: "start"}` responds with ONE markdown
 * text block: the sync (drift) playbook itself (read it, don't parse it), same
 * as onboard start. "status" and "complete" respond with one JSON text block
 * that parses with the schemas below. Sync reuses the shared coverageSchema.
 */
export const SYNC_START_CONTENT = "markdown-playbook" as const;

export const syncStatusOutputSchema = z
  .object({
    onboarded: z.boolean(),
    /** ISO timestamp of the last sync (or initial onboarding), null if never. */
    lastSyncedAt: z.string().nullable(),
    /** True when onboarded and last sync is older than the staleness threshold. */
    stale: z.boolean(),
    conceptCount: z.number().int(),
    byType: z.record(z.string(), z.number()),
    // Present only when the caller supplied `areaList`: covered vs uncovered
    // source areas + coveragePct — drift measured with the onboarding machinery.
    coverage: coverageSchema.optional(),
  })
  .strict();

export const syncCompleteOutputSchema = z
  .object({
    ok: z.literal(true),
    /** ISO timestamp stamped as the new drift baseline. */
    lastSyncedAt: z.string(),
    /** The summary concept the sync note was appended to (running sync log). */
    summaryConceptId: z.string(),
    conceptCount: z.number().int(),
    conceptsLackingCodeAreas: z.number().int(),
    byType: z.record(z.string(), z.number()),
    // Present only when the caller supplied `areaList`: the coverage the sync
    // was sealed at (having passed the thin-coverage gate).
    coverage: coverageSchema.optional(),
    // Present only when NO `areaList` was supplied: a note coverage wasn't judged.
    coverageNote: z.string().optional(),
  })
  .strict();

export const syncOutputSchema = z.union([syncCompleteOutputSchema, syncStatusOutputSchema]);

/**
 * SESSION_HOOK OUTPUT CONVENTION — `session_hook` responds with ONE markdown
 * text block: the session-hook playbook itself (read it and act on it, don't
 * parse it), same as onboard/sync start. There is no JSON form.
 */
export const SESSION_HOOK_CONTENT = "markdown-playbook" as const;

export const sessionHookOutputSchema = z.string().min(1);

// --------------------------------------------------------------- dream output

const dreamAppliedChangeSchema = z
  .object({
    kind: z.enum(["merge", "promote", "link", "contradiction"]),
    id: z.string(),
    summary: z.string(),
  })
  .strict();

/** One Dream Diary entry (engine DreamDiaryEntry): counts and ids, never dumps. */
export const dreamDiaryEntrySchema = z
  .object({
    id: z.string(),
    trigger: z.enum(["alarm", "manual"]),
    startedAt: z.string(),
    finishedAt: z.string(),
    status: z.enum(["applied", "nothing-applied", "rejected", "light-only", "reverted"]),
    light: z
      .object({
        changed: z.number().int(),
        duplicates: z.number().int(),
        outcomes: z.number().int(),
        orphans: z.number().int(),
        pendingLinks: z.number().int(),
        missingCodeAreas: z.number().int(),
      })
      .strict(),
    rem: z
      .object({
        status: z.enum(["ok", "skipped"]),
        reason: z.string().optional(),
        calls: z.number().int(),
        proposals: z.number().int(),
        themes: z.array(z.string()),
      })
      .strict(),
    deep: z
      .object({
        status: z.enum(["applied", "nothing-applied", "rejected", "skipped"]),
        reason: z.string().optional(),
        touched: z.number().int(),
        allowance: z.number().int(),
        merged: z.number().int(),
        promoted: z.number().int(),
        linked: z.number().int(),
        contradictions: z.number().int(),
      })
      .strict(),
    applied: z.array(dreamAppliedChangeSchema),
    rejected: z.record(z.string(), z.number().int()),
    revertedAt: z.string().optional(),
    markdown: z.string(),
  })
  .strict();

/** Global dreaming kill switch: off · workers-ai (no operator-paid calls; BYOK still runs) · all. */
export const dreamKillSwitchSchema = z.enum(["off", "workers-ai", "all"]);

/** An account's operator-paid (Workers AI) dream spend for one UTC day, in USD. */
export const dreamSpendSchema = z
  .object({
    /** UTC day, `YYYY-MM-DD`. */
    day: z.string(),
    usd: z.number(),
    capUsd: z.number(),
    remainingUsd: z.number(),
  })
  .strict();

/** `dream {action: "status" | "configure"}`. */
export const dreamStatusOutputSchema = z
  .object({
    enabled: z.boolean(),
    cadenceHours: z.number().int(),
    /** Start of the last completed sweep (changes after it feed the next one); null if never. */
    lastDreamAt: z.string().nullable(),
    /** When the next nightly sweep is due; null when dreaming is off or not scheduled (local). */
    nextDreamAt: z.string().nullable(),
    inFlight: z
      .object({ id: z.string(), phase: z.enum(["light", "rem", "deep"]), startedAt: z.string() })
      .strict()
      .nullable(),
    /** The LLM provider REM would use, or null (REM/deep are skipped without one). */
    llm: z.string().nullable(),
    lastEntry: dreamDiaryEntrySchema.optional(),
    /** Cloud: `workers-ai` | `byok:<provider>` | null — the provider the next REM step would use. */
    provider: z.string().nullable().optional(),
    /** Cloud: the global kill switch. */
    killSwitch: dreamKillSwitchSchema.optional(),
    /** Cloud: the vault owner's operator-paid dream spend today vs the daily cap. */
    spend: dreamSpendSchema.optional(),
  })
  .strict();

/** `dream {action: "run"}`: done (entry written), idle (nothing changed), or in-progress (continues on the alarm). */
export const dreamRunOutputSchema = z
  .object({
    status: z.enum(["done", "idle", "in-progress"]),
    id: z.string().nullable(),
    phase: z.enum(["light", "rem", "deep"]).optional(),
    entry: dreamDiaryEntrySchema.optional(),
  })
  .strict();

export const dreamDiaryOutputSchema = z
  .object({
    count: z.number().int(),
    entries: z.array(dreamDiaryEntrySchema),
  })
  .strict();

export const dreamRevertOutputSchema = z
  .object({
    id: z.string(),
    reverted: z.boolean(),
    /** Concepts restored to their pre-dream state (created ones removed). */
    restored: z.number().int(),
    /** Concepts changed since the dream — revert refuses while any exist. */
    conflicts: z.array(z.string()),
  })
  .strict();

export const dreamOutputSchema = z.union([
  dreamStatusOutputSchema,
  dreamRunOutputSchema,
  dreamDiaryOutputSchema,
  dreamRevertOutputSchema,
]);

// ----------------------------------------------------------- task tool output

/** A task concept as the task tools emit it (compact meta with task fields). */
export const taskMetaSchema = toolConceptMetaSchema.extend({
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /**
   * Computed, not stored: true when a `taken` claim has exceeded the claim TTL
   * (holder likely crashed) and is therefore reclaimable by take_task. Lets the
   * board flag stuck claims. Absent/false for fresh claims and non-taken tasks.
   */
  staleClaim: z.boolean().optional(),
});

export const listTasksOutputSchema = z
  .object({
    count: z.number().int(),
    tasks: z.array(taskMetaSchema),
  })
  .strict();

/**
 * take_task responds with ONE JSON block: the claimed task PLUS an
 * auto-assembled get_context-grade bundle for its part_of domain + realizes/
 * governed_by neighbors, so the caller can fan out immediately.
 */
export const takeTaskOutputSchema = z
  .object({
    task: taskMetaSchema,
    body: z.string(),
    context: z
      .object({
        markdown: z.string(),
        included: z.array(z.string()),
        truncated: z.boolean(),
        approxTokens: z.number(),
      })
      .strict(),
  })
  .strict();

export const completeTaskOutputSchema = z
  .object({
    task: taskMetaSchema,
    reminder: z.string(),
  })
  .strict();

export const createTaskOutputSchema = taskMetaSchema.extend({
  filePath: z.string(),
});

// -------------------------------------------------------------- annotations

/**
 * MCP tool annotations (spec 2025-06-18 `ToolAnnotations`), declared on every
 * registry entry and passed through by both servers. All three hints are
 * REQUIRED and explicit (directory reviewers reject omitted/implicit ones);
 * servers add `title` from the entry itself. Per-tool justifications are in
 * SPEC.md ("MCP tool annotations").
 *
 * - readOnlyHint: the tool never changes vault/account state.
 * - destructiveHint: the tool may delete or overwrite existing data
 *   (false = additive/state-transition writes only).
 * - openWorldHint: the tool reaches outside Brainz (sends email, calls an
 *   external LLM); false = it only touches this vault/account.
 */
export const toolAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean(),
    openWorldHint: z.boolean(),
  })
  .strict();

export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;

/** Reads only this vault. */
const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/** Writes this vault additively (creates, links, task state transitions). */
const ADDITIVE_WRITE_TOOL = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const satisfies ToolAnnotations;

/** Account write that emails a human (signup with email, sign_in, claim). */
const EMAILING_WRITE_TOOL = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

// ----------------------------------------------------------------- registry

export const MCP_TOOLS = [
  {
    name: "search_concepts",
    title: "Search concepts",
    description:
      "Search the product knowledge vault by free-text query. Use this first, whenever you need product " +
      "knowledge but don't yet know which concept ids exist — e.g. before planning work that touches a " +
      "feature, decision, or constraint. Returns ranked hits (id, title, type, score, snippet) only; " +
      "follow up with get_concept for one full note or get_context for an injectable bundle. " +
      "Never errors on odd queries — an empty hit list just means nothing matched.",
    inputSchema: searchConceptsInputSchema,
    outputSchema: searchConceptsOutputSchema,
    annotations: READ_ONLY_TOOL,
  },
  {
    name: "get_concept",
    title: "Get concept",
    description:
      "Fetch one concept by exact id: full markdown body, metadata, and its direct graph neighbors " +
      "(each with the relation that connects it). Use after search_concepts or when another note " +
      "wiki-links an id you need in full. The neighbors list tells you what to fetch next. " +
      "If you don't know the id, use search_concepts instead.",
    inputSchema: getConceptInputSchema,
    outputSchema: getConceptOutputSchema,
    annotations: READ_ONLY_TOOL,
  },
  {
    name: "get_related",
    title: "Get related concepts",
    description:
      "Walk the knowledge graph outward from a concept and return everything within `depth` hops, with " +
      "distance and the edge path that reached it. Use to map the blast radius before changing a feature " +
      "(what depends on it, what constrains it, which decisions apply) or to discover structure that " +
      "keyword search misses. Filter by relation names (e.g. depends_on) to follow only one kind of edge.",
    inputSchema: getRelatedInputSchema,
    outputSchema: getRelatedOutputSchema,
    annotations: READ_ONLY_TOOL,
  },
  {
    name: "get_context",
    title: "Assemble context bundle",
    description:
      "THE tool to call before delegating a coding task: assembles a ready-to-inject markdown briefing of " +
      "the most relevant concepts (seeded by a search query and/or explicit ids, expanded through the " +
      "graph) trimmed to a token budget. Paste the returned markdown straight into a subagent's prompt so " +
      "it gets curated product knowledge without you relaying individual notes. The final JSON line " +
      "reports which concept ids were included, whether the bundle was truncated, and its approximate " +
      "token count. Provide at least one of `query` or `ids`.",
    inputSchema: getContextInputSchema,
    outputSchema: getContextOutputSchema,
    annotations: READ_ONLY_TOOL,
  },
  {
    name: "upsert_concept",
    title: "Create or update concept",
    description:
      "Write a concept note into the vault (creates or overwrites the markdown file, then reindexes it). " +
      "Use to capture new product knowledge discovered during a task — a decision made, a constraint hit, " +
      "a pattern adopted — so future agents can find it. Omit `id` to derive a slug from the title; pass " +
      "an existing id to update that note. Body is markdown; [[wiki-links]] to other concept ids create " +
      "graph edges. Returns the saved concept's metadata.",
    inputSchema: upsertConceptInputSchema,
    outputSchema: upsertConceptOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "delete_concept",
    title: "Delete concept",
    description:
      "Remove a concept from the vault and all of its outgoing edges. Use to clear a note that is wrong, " +
      "obsolete, or junk (e.g. a probe or test node that shouldn't be in the graph). Idempotent: deleting " +
      "an id that doesn't exist is a no-op success (deleted:false), not an error. Deletion is permanent — " +
      "prefer upsert_concept to correct a note you want to keep. Returns { deleted, id }.",
    inputSchema: deleteConceptInputSchema,
    outputSchema: deleteConceptOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "link_concepts",
    title: "Link concepts",
    description:
      "Add a typed, directed edge between two existing concepts by editing the `from` note's frontmatter " +
      "(e.g. lead-scoring depends_on contact-model). Use when you notice a relationship the vault is " +
      "missing. Both concepts should already exist; use upsert_concept first if not.",
    inputSchema: linkConceptsInputSchema,
    outputSchema: linkConceptsOutputSchema,
    annotations: ADDITIVE_WRITE_TOOL,
  },
  {
    name: "list_concepts",
    title: "List concepts",
    description:
      "Enumerate concept metadata (no bodies), optionally filtered by product, type, or a single tag. " +
      "Use to get the lay of the land in an unfamiliar vault, to audit what exists (e.g. all decisions " +
      "for a product), or when search vocabulary isn't matching. For content, follow up with get_concept " +
      "or get_context.",
    inputSchema: listConceptsInputSchema,
    outputSchema: listConceptsOutputSchema,
    annotations: READ_ONLY_TOOL,
  },
  {
    name: "vault_stats",
    title: "Vault stats",
    description:
      "Cheap orientation call: counts of concepts and edges, the products and tags in use, a breakdown " +
      "by concept type, and whether semantic search is available. Call once when connecting to an " +
      "unfamiliar vault to calibrate how much knowledge is here and which product/tag filters exist.",
    inputSchema: vaultStatsInputSchema,
    outputSchema: vaultStatsOutputSchema,
    annotations: READ_ONLY_TOOL,
  },
  {
    name: "onboard",
    title: "Onboard this vault",
    description:
      "Step 1 on any new vault: onboarding turns an existing product's codebase into the knowledge graph " +
      "your whole agent fleet shares. Call {action: \"start\"} to receive the onboarding playbook — " +
      "instructions for fanning subagents out over the codebase and distilling product knowledge " +
      "(domains, features, stories, specs, workflows, decisions, constraints) into concepts via " +
      "upsert_concept, each anchored to the code with codeAreas. There is NO flat concept cap — size the " +
      "effort from the codebase; for a large project expect 200–800+ concepts and do NOT stop at a few " +
      "dozen. Onboarding is a LOOP: index an area, then call {action: \"status\", areaList} (you supply " +
      "your repo's source areas — Brainz can't read the repo) to see covered vs uncovered areas; keep " +
      "indexing the uncovered ones until coverage is broad. When it is, call {action: \"complete\", " +
      "summary, areaList} to mark the vault onboarded and store the summary — complete is coverage-gated " +
      "and rejects if too many areas are still uncovered. {action: \"status\"} reports onboarded state, " +
      "concept counts, and (with areaList) coverage. Until onboarding completes, search_concepts and " +
      "get_context results carry a reminder to run it.",
    inputSchema: onboardInputSchema,
    outputSchema: onboardOutputSchema,
    annotations: ADDITIVE_WRITE_TOOL,
  },
  {
    name: "sync",
    title: "Sync this vault to the current code",
    description:
      "Re-onboard: keep the knowledge graph TRUE to the artifact as code changes. Onboarding is one-shot; " +
      "`sync` is the supported path to re-index drift. Call {action: \"start\"} to receive the sync playbook — a " +
      "DRIFT playbook (NOT the full onboarding one): it embeds a coverage map over your concepts' code_areas " +
      "and instructs you to (a) diff the codebase since last_synced_at with git (you run git — Brainz can't " +
      "read the repo — and pass back changedPaths + areaList), (b) fan out over the CHANGED areas only, (c) " +
      "UPDATE stale concepts whose code_areas changed (in place, don't duplicate), (d) INDEX new/un-mapped work " +
      "as new concepts and file tasks for incomplete work, (e) report coverage gaps. {action: \"status\", " +
      "areaList} reports onboarded state, last sync time, staleness, concept counts, and coverage. When the " +
      "changed areas are re-indexed call {action: \"complete\", summary, areaList} — it stamps last_synced_at " +
      "and APPENDS your summary to the product-onboarding-summary concept (a running sync log). Past ~14 days " +
      "without a sync, get_context and search results carry a staleness reminder to run it.",
    inputSchema: syncInputSchema,
    outputSchema: syncOutputSchema,
    annotations: ADDITIVE_WRITE_TOOL,
  },
  {
    name: "session_hook",
    title: "Install the Brainz session hook",
    description:
      "Make Brainz the default in EVERY future session, not just this one. Returns the session-hook " +
      "playbook: a short primer (get_context before planning or delegating, take_task for work, " +
      "upsert_concept to write back what changed) plus the exact steps to install it as a session-start " +
      "hook in your own harness — a Claude Code SessionStart hook in .claude/settings.json, or a marked " +
      "block in AGENTS.md / your client's rules file. Brainz can't write to your repo, so YOU apply the " +
      "edits. Call this once per repository, right after connecting (or after onboarding); the steps are " +
      "idempotent, so re-running refreshes the primer instead of duplicating it.",
    inputSchema: sessionHookInputSchema,
    outputSchema: sessionHookOutputSchema,
    annotations: READ_ONLY_TOOL,
  },
  {
    name: "dream",
    title: "Dream (nightly consolidation)",
    description:
      "Brainz dreams: an autonomous, unattended consolidation sweep that improves the graph between agent " +
      "sessions. Light stages what changed since the last dream (near-duplicate concepts, finished task " +
      "outcomes, hygiene counts); REM asks an LLM for proposals; deep applies the ones that pass threshold " +
      "gates — merges duplicates (edges redirected, the other tombstoned), promotes outcome knowledge into " +
      "concepts, adds missing links, and files a task for each contradiction instead of picking a side. A " +
      "sweep that would touch too much of the vault is rejected; every applied dream keeps preimages and can " +
      "be reverted. {action: \"status\"} shows schedule + last dream; {action: \"run\"} dreams now; " +
      "{action: \"diary\"} reads the Dream Diary; {action: \"revert\", id} undoes one dream; " +
      "{action: \"configure\", enabled?, cadenceHours?} sets it up. Without an LLM only light runs.",
    inputSchema: dreamInputSchema,
    outputSchema: dreamOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description:
      "List the vault's work pile: `task`-type concepts with their lifecycle (open/taken/done), oldest " +
      "first. Call to survey what's outstanding before claiming work, to check what a teammate agent is " +
      "already doing (taskStatus \"taken\" with takenBy), or to audit completed work. Filter by taskStatus " +
      "or by the domain the tasks are part_of. To actually pick up work, use take_task — don't just read.",
    inputSchema: listTasksInputSchema,
    outputSchema: listTasksOutputSchema,
    annotations: READ_ONLY_TOOL,
  },
  {
    name: "take_task",
    title: "Take a task off the pile",
    description:
      "Claim a unit of work and get briefed in one call. Pass an `id` to claim a specific task, or omit it " +
      "to claim THE next open task (deterministic: oldest open by createdAt then id) — safe to call " +
      "repeatedly to drain the pile. Atomically flips the task to \"taken\" and records takenBy/takenAt; " +
      "errors if it's already taken or done. Returns the task AND an auto-assembled get_context-grade " +
      "briefing for its part_of domain plus the concepts it realizes / is governed_by (with code_areas) — " +
      "paste that straight into your implementation. THE CONTRACT: after implementing, verify the artifact " +
      "matches every spec that governs the task; fix or file a new task for any discrepancy; then index the " +
      "new/changed knowledge via upsert_concept and call complete_task.",
    inputSchema: takeTaskInputSchema,
    outputSchema: takeTaskOutputSchema,
    annotations: ADDITIVE_WRITE_TOOL,
  },
  {
    name: "complete_task",
    title: "Complete a task",
    description:
      "Mark a task done once the work is in the artifact. Sets taskStatus=done + doneAt and appends your " +
      "`outcome` to the task body as an Outcome section. The result reminds you to index what changed via " +
      "upsert_concept so the knowledge graph stays true to the codebase — do that before moving on.",
    inputSchema: completeTaskInputSchema,
    outputSchema: completeTaskOutputSchema,
    annotations: ADDITIVE_WRITE_TOOL,
  },
  {
    name: "create_task",
    title: "Create a task",
    description:
      "Turn a finding into first-class work: creates a `task`-type concept with taskStatus=open and the " +
      "given relations — part_of a domain, `realizes` stories/features, `governed_by` specs — plus " +
      "codeAreas pointing at where the work lands. Use when you discover work that isn't reflected in the " +
      "codebase yet (a gap, a needed fix, a follow-up). The task then shows up in list_tasks / take_task " +
      "and on the Kanban board.",
    inputSchema: createTaskInputSchema,
    outputSchema: createTaskOutputSchema,
    annotations: ADDITIVE_WRITE_TOOL,
  },
] as const;

// ------------------------------------------------- public (unauthenticated)

export const signupInputSchema = z.object({
  vaultName: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Name for the first vault (default "My vault").'),
  email: z
    .string()
    .email()
    .optional()
    .describe(
      "Optional: your human's email. Supplying it fires the same claim-request flow as the `claim` " +
        "tool — an approval link is EMAILED to the human (never returned to you). The email is NOT " +
        "bound to the workspace until the human approves it.",
    ),
});

export const signupOutputSchema = z
  .object({
    apiKey: z.string(),
    vaultSlug: z.string(),
    /** ISO timestamp: when the workspace expires if it is never claimed (~7 days). */
    expiresAt: z.string(),
    /** True whenever an `email` was supplied (regardless of the address's eligibility). */
    claimEmailSent: z.boolean(),
  })
  .strict();

export const signInInputSchema = z.object({
  email: z
    .string()
    .email()
    .describe(
      "Your human's email address. A magic sign-in link is EMAILED there — it is NEVER returned to " +
        "you, so do not ask for it or try to open it; your human must click it from their inbox.",
    ),
});

export const signInOutputSchema = z
  .object({
    /** Always "sent" — a deliberately generic confirmation (no account-existence leak). */
    status: z.literal("sent"),
  })
  .strict();

/**
 * PUBLIC_MCP_TOOLS — the toolset an UNAUTHENTICATED /mcp connection sees on
 * Brainz Cloud: `signup` (provision an anonymous workspace) and `sign_in`
 * (email a returning human a magic sign-in link). Deliberately NOT part of
 * MCP_TOOLS (the local stdio server has no accounts, and the authenticated
 * remote surface stays the vault tools).
 */
export const PUBLIC_MCP_TOOLS = [
  {
    name: "signup",
    title: "Sign up (provision an anonymous workspace)",
    description:
      "Provision an ANONYMOUS, PROVISIONAL Brainz Cloud workspace: a first knowledge vault and a " +
      "working API key — no email required, no human action required. Keep the returned apiKey " +
      "SECRET: never log, echo, or print it. Send it as `Authorization: Bearer <apiKey>` to this " +
      "same /mcp endpoint and the vault tools unlock immediately. The workspace EXPIRES in 7 days " +
      "(see `expiresAt`) unless a human claims it: call the `claim` tool (authenticated) with your " +
      "human's email — the approval link is EMAILED to them and is NEVER returned to you. signup " +
      "returns no URL of any kind. Optionally pass `email` now to fire that same claim request in " +
      "one call.",
    inputSchema: signupInputSchema,
    outputSchema: signupOutputSchema,
    annotations: EMAILING_WRITE_TOOL,
  },
  {
    name: "sign_in",
    title: "Sign in (email a magic sign-in link)",
    description:
      "Request a magic SIGN-IN email for a human who ALREADY has a Brainz Cloud account (use `signup` " +
      "to create a new workspace). A one-time sign-in link is EMAILED to the address — it is NEVER " +
      "returned to you, so do not ask for it or try to open it. Tell your human to open their inbox " +
      "and click the link; that is the ONLY way to complete sign-in. The result only confirms an " +
      "email is on its way and reveals nothing about whether the address has an account. Rate-limited " +
      "to 5 sign-in emails per hour per address.",
    inputSchema: signInInputSchema,
    outputSchema: signInOutputSchema,
    annotations: EMAILING_WRITE_TOOL,
  },
] as const;

export type PublicMcpTool = (typeof PUBLIC_MCP_TOOLS)[number];
export type PublicMcpToolName = PublicMcpTool["name"];
export type SignupInput = z.infer<typeof signupInputSchema>;
export type SignupOutput = z.infer<typeof signupOutputSchema>;
export type SignInInput = z.infer<typeof signInInputSchema>;
export type SignInOutput = z.infer<typeof signInOutputSchema>;

// ------------------------------------------------------- cloud-only (authed)

export const claimInputSchema = z.object({
  email: z
    .string()
    .email()
    .describe(
      "Your human's email address. The claim-approval link is EMAILED there — you never see it.",
    ),
});

export const claimOutputSchema = z
  .object({
    status: z.literal("sent"),
    /** ISO timestamp: when the emailed approval link expires (24 h). */
    expiresAt: z.string(),
  })
  .strict();

/**
 * CLOUD_MCP_TOOLS — cloud-only tools registered by apps/cloud's AUTHENTICATED
 * remote MCP server alongside the vault tools. The local stdio server
 * (@brainz/mcp-server) never sees these: they concern accounts, which only
 * exist on Brainz Cloud. Deliberately NOT part of MCP_TOOLS.
 */
export const CLOUD_MCP_TOOLS = [
  {
    name: "claim",
    title: "Claim this workspace for your human",
    description:
      "Make this provisional workspace permanent by attaching it to your human's email. The " +
      "approval link is EMAILED to the human — it is NEVER returned to you, so do not ask for it " +
      "or try to open it; tell your human to check their inbox and approve. Call this ONCE with " +
      "your human's email, then wait: the result only confirms the email was sent (`expiresAt` is " +
      "the approval link's 24-hour deadline). Until the human approves, the workspace still " +
      "expires on its 7-day signup schedule. Errors if the workspace is already claimed.",
    inputSchema: claimInputSchema,
    outputSchema: claimOutputSchema,
    annotations: EMAILING_WRITE_TOOL,
  },
] as const;

export type CloudMcpTool = (typeof CLOUD_MCP_TOOLS)[number];
export type CloudMcpToolName = CloudMcpTool["name"];
export type ClaimInput = z.infer<typeof claimInputSchema>;
export type ClaimOutput = z.infer<typeof claimOutputSchema>;

export const CLOUD_MCP_TOOL_NAMES = CLOUD_MCP_TOOLS.map(
  (t) => t.name,
) as readonly CloudMcpToolName[];

export const PUBLIC_MCP_TOOL_NAMES = PUBLIC_MCP_TOOLS.map(
  (t) => t.name,
) as readonly PublicMcpToolName[];

export type McpTool = (typeof MCP_TOOLS)[number];
export type McpToolName = McpTool["name"];

export type McpToolInput<N extends McpToolName = McpToolName> = z.infer<
  Extract<McpTool, { name: N }>["inputSchema"]
>;
export type McpToolOutput<N extends McpToolName = McpToolName> = z.infer<
  Extract<McpTool, { name: N }>["outputSchema"]
>;

export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name) as readonly McpToolName[];

/**
 * PUBLIC_VAULT_READ_TOOL_NAMES — the READ-ONLY subset of MCP_TOOLS that an
 * anonymous public-vault token (see api.ts publicEnableResponseSchema) may call
 * over /mcp. A public token resolves to VIEWER scope: search/read/context only,
 * NO writes (upsert/delete/link), NO task mutations (create/take/complete_task),
 * NO onboard, and NONE of the account tools (signup/sign_in/claim). Enforced by
 * building the public MCP server from exactly this list — write tools are never
 * registered, so they cannot be invoked. Order-independent (it's a membership
 * set); keep it in sync with the read tools in MCP_TOOLS.
 */
export const PUBLIC_VAULT_READ_TOOL_NAMES = [
  "search_concepts",
  "get_concept",
  "get_related",
  "get_context",
  "list_concepts",
  "vault_stats",
] as const satisfies readonly McpToolName[];

export type PublicVaultReadToolName = (typeof PUBLIC_VAULT_READ_TOOL_NAMES)[number];

/** Look up a registry entry by name, preserving its concrete schema types. */
export function getMcpTool<N extends McpToolName>(name: N): Extract<McpTool, { name: N }> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown MCP tool: ${name}`);
  return tool as Extract<McpTool, { name: N }>;
}

/** Widened view of a registry entry, for callers that iterate MCP_TOOLS generically. */
export interface McpToolDef {
  readonly name: McpToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.AnyZodObject;
  readonly outputSchema: z.ZodTypeAny;
  readonly annotations: ToolAnnotations;
}

// Compile-time guard: every registry entry satisfies the widened shape.
const _mcpToolDefs: readonly McpToolDef[] = MCP_TOOLS;
void _mcpToolDefs;

/** Widened view of a public-registry entry (same shape, public tool names). */
export interface PublicMcpToolDef {
  readonly name: PublicMcpToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.AnyZodObject;
  readonly outputSchema: z.ZodTypeAny;
  readonly annotations: ToolAnnotations;
}

const _publicMcpToolDefs: readonly PublicMcpToolDef[] = PUBLIC_MCP_TOOLS;
void _publicMcpToolDefs;

/** Widened view of a cloud-only registry entry (same shape, cloud tool names). */
export interface CloudMcpToolDef {
  readonly name: CloudMcpToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.AnyZodObject;
  readonly outputSchema: z.ZodTypeAny;
  readonly annotations: ToolAnnotations;
}

const _cloudMcpToolDefs: readonly CloudMcpToolDef[] = CLOUD_MCP_TOOLS;
void _cloudMcpToolDefs;
