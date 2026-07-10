/**
 * Remote MCP endpoint (Streamable HTTP): https://brain.brownmatter.ai/mcp
 *
 * Auth: `Authorization: Bearer bz_...` → SHA-256 → D1 api_key lookup → that
 * key's vault DO. 401 otherwise. Stateless: a fresh McpServer + transport per
 * request (no session ids), served through @hono/mcp's fetch-native
 * StreamableHTTPTransport — chosen over the Cloudflare agents SDK's McpAgent
 * because McpAgent wants to own Worker routing/DO wiring, which fights
 * adapter-cloudflare's single compiled worker; @hono/mcp drops cleanly into a
 * SvelteKit endpoint.
 *
 * Client wiring:
 *   claude mcp add --transport http brainz https://brain.brownmatter.ai/mcp \
 *     --header "Authorization: Bearer bz_..."
 */
import type { RequestHandler } from "@sveltejs/kit";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { apiError, requirePlatform } from "$lib/server/api-util";
import { resolveApiKey } from "$lib/server/vault-access";
import { buildMcpServer } from "$lib/server/mcp";
import { vaultClient } from "$lib/server/vault-client";

const handleMcp: RequestHandler = async (event) => {
  const platform = requirePlatform(event);

  const resolved = await resolveApiKey(event).catch(() => null);
  if (!resolved) {
    return new Response(JSON.stringify({ error: "unauthorized: provide a Bearer bz_ API key" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="brainz-cloud"',
      },
    });
  }

  const client = vaultClient(platform.env.VAULT_DO, resolved.vault.id);
  const server = buildMcpServer(client);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);

  // @hono/mcp needs a Hono context; a per-request micro-app provides one.
  const app = new Hono();
  app.all("*", (c) => transport.handleRequest(c));
  try {
    return await app.fetch(event.request);
  } catch (err) {
    return apiError(500, err instanceof Error ? err.message : "mcp transport error");
  }
};

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;
