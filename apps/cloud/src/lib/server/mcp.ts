/**
 * Remote MCP server over a vault's Durable Object.
 *
 * Tool names/descriptions/schemas come from MCP_TOOLS in @brainz/contracts —
 * the same registry @brainz/mcp-server (stdio) iterates; only the handlers
 * differ (they call the VaultDO instead of a local Vault). Same handler-map
 * pattern, same wire shapes (tests parse responses with the contract
 * outputSchema).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MCP_TOOLS,
  type McpToolDef,
  type McpToolInput,
  type McpToolName,
} from "@brainz/contracts";
import { syntheticFilePath } from "./do-helpers";
import { VaultDoError, type VaultClient } from "./vault-client";

export const SERVER_NAME = "brainz-cloud";
export const SERVER_VERSION = "0.1.0";

type TextContent = { type: "text"; text: string };
export type ToolResult = { content: TextContent[]; isError?: boolean };

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Never throw across the MCP boundary — errors become isError results. */
export async function guarded(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

type ToolHandlers = {
  [N in McpToolName]: (args: McpToolInput<N>) => Promise<ToolResult>;
};

/** Build the MCP server for one vault (stateless: one per request). */
export function buildMcpServer(vault: VaultClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const handlers: ToolHandlers = {
    search_concepts: async ({ query, mode, product, tags, type, limit }) =>
      guarded(async () => {
        const { hits } = await vault.search({ query, mode, product, tags, type, limit });
        return ok({ hits });
      }),

    get_concept: async ({ id }) =>
      guarded(async () => {
        const { concept } = await vault.getConcept(id);
        if (!concept) {
          return fail(
            `no concept with id "${id}" — use search_concepts or list_concepts to find valid ids`,
          );
        }
        const { neighbors, body, createdAt, updatedAt, ...meta } = concept;
        return ok({
          ...meta,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          filePath: syntheticFilePath(concept.id),
          body,
          neighbors,
        });
      }),

    get_related: async ({ id, depth, limit, relations }) =>
      guarded(async () => {
        try {
          const result = await vault.related({ id, depth, limit, relations });
          return ok(result);
        } catch (err) {
          if (err instanceof VaultDoError && err.status === 404) return fail(err.message);
          throw err;
        }
      }),

    get_context: async ({ query, ids, product, depth, tokenBudget }) =>
      guarded(async () => {
        if (!query && (!ids || ids.length === 0)) {
          return fail("get_context requires at least one of `query` or `ids`");
        }
        const bundle = await vault.context({ query, ids, product, depth, tokenBudget });
        // Two-block convention (GET_CONTEXT_CONTENT_BLOCKS in @brainz/contracts):
        // markdown briefing first, then the JSON footer.
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

    upsert_concept: async ({ id, title, body, type, status, product, tags, relations }) =>
      guarded(async () => {
        const { concept } = await vault.upsertConcept({
          id,
          title,
          body,
          type,
          status,
          product,
          tags,
          relations,
        });
        return ok({
          id: concept.id,
          title: concept.title,
          type: concept.type,
          status: concept.status,
          ...(concept.product !== undefined ? { product: concept.product } : {}),
          tags: concept.tags,
          filePath: syntheticFilePath(concept.id),
        });
      }),

    link_concepts: async ({ from, to, relation }) =>
      guarded(async () => {
        try {
          const result = await vault.link({ from, to, relation });
          return ok(result);
        } catch (err) {
          if (err instanceof VaultDoError && err.status === 404) return fail(err.message);
          throw err;
        }
      }),

    list_concepts: async ({ product, type, tag }) =>
      guarded(async () => {
        const result = await vault.list({ product, type, tag });
        return ok(result);
      }),

    vault_stats: async () =>
      guarded(async () => {
        const { concepts, edges, products, tags, byType, embeddings } = await vault.stats();
        // keywordIndex is intentionally dropped: vault_stats' contract shape is strict.
        return ok({ concepts, edges, products, tags, byType, embeddings });
      }),
  };

  for (const tool of MCP_TOOLS as readonly McpToolDef[]) {
    const handler = handlers[tool.name] as (args: Record<string, unknown>) => Promise<ToolResult>;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
      },
      async (args: Record<string, unknown>) => handler(args),
    );
  }

  return server;
}
