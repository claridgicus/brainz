/**
 * MCP tool registry — THE source of truth for the 8 Brainz tools.
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
  conceptStatusSchema,
  conceptTypeSchema,
  edgeSchema,
  embeddingStatusSchema,
  vaultStatsSchema,
} from "./domain.js";

/** Compact concept metadata as MCP tools emit it: no absolute filePath noise. */
export const toolConceptMetaSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: conceptTypeSchema,
    status: conceptStatusSchema,
    product: z.string().optional(),
    tags: z.array(z.string()),
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
  type: z.enum(CONCEPT_TYPES).optional().describe("Concept type (default \"concept\")."),
  status: z.enum(CONCEPT_STATUSES).optional().describe("Lifecycle status (default \"active\")."),
  product: z.string().optional().describe("Product grouping key."),
  tags: z.array(z.string()).optional().describe("Tags for filtering."),
  relations: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe("Typed edges, e.g. {\"depends_on\": [\"auth-system\"]}."),
});

export const linkConceptsInputSchema = z.object({
  from: z.string().describe("Source concept id (its file gains the relation)."),
  to: z.string().describe("Target concept id."),
  relation: z
    .string()
    .default("related_to")
    .describe("Edge type, e.g. depends_on | part_of | constrains | supersedes | related_to (default)."),
});

export const listConceptsInputSchema = z.object({
  product: z.string().optional().describe("Only concepts of this product."),
  type: z.enum(CONCEPT_TYPES).optional().describe("Only concepts of this type."),
  tag: z.string().optional().describe("Only concepts carrying this tag."),
});

export const vaultStatsInputSchema = z.object({});

// ------------------------------------------------------------ output schemas

export const searchConceptsOutputSchema = z
  .object({
    hits: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          type: conceptTypeSchema,
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
 * outputSchema.
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
});

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
  },
] as const;

export type McpTool = (typeof MCP_TOOLS)[number];
export type McpToolName = McpTool["name"];

export type McpToolInput<N extends McpToolName = McpToolName> = z.infer<
  Extract<McpTool, { name: N }>["inputSchema"]
>;
export type McpToolOutput<N extends McpToolName = McpToolName> = z.infer<
  Extract<McpTool, { name: N }>["outputSchema"]
>;

export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name) as readonly McpToolName[];

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
}

// Compile-time guard: every registry entry satisfies the widened shape.
const _mcpToolDefs: readonly McpToolDef[] = MCP_TOOLS;
void _mcpToolDefs;
