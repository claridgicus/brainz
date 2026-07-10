import * as path from "node:path";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConceptMeta, Vault } from "@brainz/core";

const CONCEPT_TYPES = [
  "concept",
  "feature",
  "decision",
  "constraint",
  "pattern",
  "glossary",
] as const;
const CONCEPT_STATUSES = ["active", "draft", "deprecated"] as const;

export const SERVER_NAME = "brainz";
export const SERVER_VERSION = "0.1.0";

/**
 * Resolve the vault directory from CLI args / environment:
 * `--vault <dir>` (or `--vault=<dir>`), else `BRAINZ_VAULT`, else cwd.
 */
export function resolveVaultDir(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vault") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--vault requires a directory argument");
      }
      return path.resolve(value);
    }
    if (arg.startsWith("--vault=")) {
      const value = arg.slice("--vault=".length);
      if (!value) throw new Error("--vault requires a directory argument");
      return path.resolve(value);
    }
  }
  if (env.BRAINZ_VAULT) return path.resolve(env.BRAINZ_VAULT);
  return process.cwd();
}

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Run a tool handler; any thrown error becomes an isError result instead of crossing the MCP boundary. */
async function guarded(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Compact meta for tool output: drop absolute filePath noise, keep what an agent needs. */
function compactMeta(c: ConceptMeta) {
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    status: c.status,
    ...(c.product !== undefined ? { product: c.product } : {}),
    tags: c.tags,
  };
}

/**
 * Build the Brainz MCP server over an already-opened Vault.
 * The caller owns the vault lifecycle (open/close) and the transport.
 */
export function createServer(vault: Vault): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ------------------------------------------------------------ tools

  server.registerTool(
    "search_concepts",
    {
      title: "Search concepts",
      description:
        "Search the product knowledge vault by free-text query. Use this first, whenever you need product " +
        "knowledge but don't yet know which concept ids exist — e.g. before planning work that touches a " +
        "feature, decision, or constraint. Returns ranked hits (id, title, type, score, snippet) only; " +
        "follow up with get_concept for one full note or get_context for an injectable bundle. " +
        "Never errors on odd queries — an empty hit list just means nothing matched.",
      inputSchema: {
        query: z.string().describe("Free-text search query, e.g. \"lead scoring\" or \"session auth\"."),
        mode: z
          .enum(["hybrid", "keyword", "semantic"])
          .default("hybrid")
          .describe("Search mode. \"hybrid\" (default) fuses keyword and semantic ranking; semantic silently falls back to keyword if embeddings are unavailable."),
        product: z.string().optional().describe("Only return concepts belonging to this product."),
        tags: z.array(z.string()).optional().describe("Only return concepts carrying ALL of these tags."),
        type: z.enum(CONCEPT_TYPES).optional().describe("Only return concepts of this type."),
        limit: z.number().int().min(1).max(50).default(10).describe("Max hits to return (default 10)."),
      },
    },
    async ({ query, mode, product, tags, type, limit }) =>
      guarded(async () => {
        const hits = await vault.search({ query, mode, product, tags, type, limit });
        return ok({
          hits: hits.map((h) => ({
            id: h.concept.id,
            title: h.concept.title,
            type: h.concept.type,
            score: h.score,
            snippet: h.snippet,
          })),
        });
      }),
  );

  server.registerTool(
    "get_concept",
    {
      title: "Get concept",
      description:
        "Fetch one concept by exact id: full markdown body, metadata, and its direct graph neighbors " +
        "(each with the relation that connects it). Use after search_concepts or when another note " +
        "wiki-links an id you need in full. The neighbors list tells you what to fetch next. " +
        "If you don't know the id, use search_concepts instead.",
      inputSchema: {
        id: z.string().describe("Exact concept id (slug), e.g. \"lead-scoring\"."),
      },
    },
    async ({ id }) =>
      guarded(() => {
        const concept = vault.getConcept(id);
        if (!concept) {
          return fail(
            `no concept with id "${id}" — use search_concepts or list_concepts to find valid ids`,
          );
        }
        const neighbors = vault.related(id, { depth: 1 }).map((node) => {
          const edge = node.via[node.via.length - 1];
          return {
            ...compactMeta(node.concept),
            relation: edge?.relation ?? "related_to",
            direction: edge ? (edge.from === id ? "out" : "in") : "out",
          };
        });
        return ok({
          ...compactMeta(concept),
          ...(concept.createdAt !== undefined ? { createdAt: concept.createdAt } : {}),
          ...(concept.updatedAt !== undefined ? { updatedAt: concept.updatedAt } : {}),
          filePath: concept.filePath,
          body: concept.body,
          neighbors,
        });
      }),
  );

  server.registerTool(
    "get_related",
    {
      title: "Get related concepts",
      description:
        "Walk the knowledge graph outward from a concept and return everything within `depth` hops, with " +
        "distance and the edge path that reached it. Use to map the blast radius before changing a feature " +
        "(what depends on it, what constrains it, which decisions apply) or to discover structure that " +
        "keyword search misses. Filter by relation names (e.g. depends_on) to follow only one kind of edge.",
      inputSchema: {
        id: z.string().describe("Concept id to start from."),
        depth: z.number().int().min(1).max(3).default(1).describe("How many hops to traverse (1-3, default 1)."),
        limit: z.number().int().min(1).optional().describe("Max related nodes to return."),
        relations: z
          .array(z.string())
          .optional()
          .describe("Only follow edges with these relation names, e.g. [\"depends_on\", \"part_of\"]."),
      },
    },
    async ({ id, depth, limit, relations }) =>
      guarded(() => {
        if (!vault.getConcept(id)) {
          return fail(
            `no concept with id "${id}" — use search_concepts or list_concepts to find valid ids`,
          );
        }
        const nodes = vault.related(id, { depth, limit, relations });
        return ok({
          id,
          related: nodes.map((node) => ({
            ...compactMeta(node.concept),
            distance: node.distance,
            via: node.via.map((e) => ({ from: e.from, to: e.to, relation: e.relation })),
          })),
        });
      }),
  );

  server.registerTool(
    "get_context",
    {
      title: "Assemble context bundle",
      description:
        "THE tool to call before delegating a coding task: assembles a ready-to-inject markdown briefing of " +
        "the most relevant concepts (seeded by a search query and/or explicit ids, expanded through the " +
        "graph) trimmed to a token budget. Paste the returned markdown straight into a subagent's prompt so " +
        "it gets curated product knowledge without you relaying individual notes. The final JSON line " +
        "reports which concept ids were included, whether the bundle was truncated, and its approximate " +
        "token count. Provide at least one of `query` or `ids`.",
      inputSchema: {
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
      },
    },
    async ({ query, ids, product, depth, tokenBudget }) =>
      guarded(async () => {
        if (!query && (!ids || ids.length === 0)) {
          return fail("get_context requires at least one of `query` or `ids`");
        }
        const bundle = await vault.assembleContext({ query, ids, product, depth, tokenBudget });
        const footer = JSON.stringify({
          included: bundle.included.map((c) => c.id),
          truncated: bundle.truncated,
          approxTokens: bundle.approxTokens,
        });
        return {
          content: [
            { type: "text", text: bundle.markdown },
            { type: "text", text: footer },
          ],
        };
      }),
  );

  server.registerTool(
    "upsert_concept",
    {
      title: "Create or update concept",
      description:
        "Write a concept note into the vault (creates or overwrites the markdown file, then reindexes it). " +
        "Use to capture new product knowledge discovered during a task — a decision made, a constraint hit, " +
        "a pattern adopted — so future agents can find it. Omit `id` to derive a slug from the title; pass " +
        "an existing id to update that note. Body is markdown; [[wiki-links]] to other concept ids create " +
        "graph edges. Returns the saved concept's metadata.",
      inputSchema: {
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
      },
    },
    async ({ id, title, body, type, status, product, tags, relations }) =>
      guarded(async () => {
        const saved = await vault.upsertConcept({
          id,
          title,
          body,
          type,
          status,
          product,
          tags,
          relations,
        });
        return ok({ ...compactMeta(saved), filePath: saved.filePath });
      }),
  );

  server.registerTool(
    "link_concepts",
    {
      title: "Link concepts",
      description:
        "Add a typed, directed edge between two existing concepts by editing the `from` note's frontmatter " +
        "(e.g. lead-scoring depends_on contact-model). Use when you notice a relationship the vault is " +
        "missing. Both concepts should already exist; use upsert_concept first if not.",
      inputSchema: {
        from: z.string().describe("Source concept id (its file gains the relation)."),
        to: z.string().describe("Target concept id."),
        relation: z
          .string()
          .default("related_to")
          .describe("Edge type, e.g. depends_on | part_of | constrains | supersedes | related_to (default)."),
      },
    },
    async ({ from, to, relation }) =>
      guarded(async () => {
        await vault.link(from, to, relation);
        return ok({ ok: true, from, to, relation });
      }),
  );

  server.registerTool(
    "list_concepts",
    {
      title: "List concepts",
      description:
        "Enumerate concept metadata (no bodies), optionally filtered by product, type, or a single tag. " +
        "Use to get the lay of the land in an unfamiliar vault, to audit what exists (e.g. all decisions " +
        "for a product), or when search vocabulary isn't matching. For content, follow up with get_concept " +
        "or get_context.",
      inputSchema: {
        product: z.string().optional().describe("Only concepts of this product."),
        type: z.enum(CONCEPT_TYPES).optional().describe("Only concepts of this type."),
        tag: z.string().optional().describe("Only concepts carrying this tag."),
      },
    },
    async ({ product, type, tag }) =>
      guarded(() => {
        const concepts = vault.listConcepts({ product, type, tag });
        return ok({ count: concepts.length, concepts: concepts.map(compactMeta) });
      }),
  );

  server.registerTool(
    "vault_stats",
    {
      title: "Vault stats",
      description:
        "Cheap orientation call: counts of concepts and edges, the products and tags in use, a breakdown " +
        "by concept type, and whether semantic search is available. Call once when connecting to an " +
        "unfamiliar vault to calibrate how much knowledge is here and which product/tag filters exist.",
      inputSchema: {},
    },
    async () =>
      guarded(() => {
        const stats = vault.stats();
        return ok({ ...stats, embeddings: vault.embeddingStatus });
      }),
  );

  // ------------------------------------------------------------ resources

  server.registerResource(
    "concept",
    new ResourceTemplate("brainz://concept/{id}", {
      list: async () => ({
        resources: vault.listConcepts().map((c) => ({
          uri: `brainz://concept/${c.id}`,
          name: c.title,
          description: `${c.type} — ${c.id}`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Vault concept",
      description: "Markdown source of a concept note in the Brainz vault.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      const concept = vault.getConcept(id);
      if (!concept) throw new Error(`no concept with id "${id}"`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# ${concept.title}\n\n${concept.body}`,
          },
        ],
      };
    },
  );

  return server;
}
