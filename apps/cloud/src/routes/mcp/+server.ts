/**
 * Remote MCP endpoint (Streamable HTTP): https://brain.brownmatter.ai/mcp
 *
 * Auth split:
 * - `Authorization: Bearer bz_...` (valid) → SHA-256 → D1 api_key lookup →
 *   that key's vault DO, serving the 8 authenticated vault tools.
 * - Authorization header present but invalid/revoked → 401, exactly as before.
 * - NO Authorization header → the PUBLIC MCP server: exactly one tool,
 *   `signup` (agent-driven account provisioning; see PUBLIC_MCP_TOOLS in
 *   @brainz/contracts and $lib/server/public-mcp).
 *
 * Stateless: a fresh McpServer + transport per request (no session ids),
 * served through @hono/mcp's fetch-native StreamableHTTPTransport — chosen
 * over the Cloudflare agents SDK's McpAgent because McpAgent wants to own
 * Worker routing/DO wiring, which fights adapter-cloudflare's single compiled
 * worker; @hono/mcp drops cleanly into a SvelteKit endpoint.
 *
 * Client wiring:
 *   claude mcp add --transport http brainz https://brain.brownmatter.ai/mcp \
 *     --header "Authorization: Bearer bz_..."
 */
import type { RequestHandler } from "@sveltejs/kit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { apiError, requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { resolveApiKey } from "$lib/server/vault-access";
import { buildMcpServer } from "$lib/server/mcp";
import { buildPublicMcpServer, signupDepsFromDb } from "$lib/server/public-mcp";
import { vaultClient } from "$lib/server/vault-client";

const handleMcp: RequestHandler = async (event) => {
  const platform = requirePlatform(event);

  let server: McpServer;
  if (event.request.headers.get("authorization") === null) {
    // Absent auth → public server (signup tool only). Invalid auth never
    // lands here — it still 401s below.
    server = buildPublicMcpServer(
      signupDepsFromDb(createDb(platform.env.DB), {
        ip: event.request.headers.get("cf-connecting-ip") ?? "local",
        // Claim URLs must be https://brain.brownmatter.ai in production —
        // BETTER_AUTH_URL pins it there; local dev falls back to the request.
        origin: platform.env.BETTER_AUTH_URL ?? event.url.origin,
      }),
    );
  } else {
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
    server = buildMcpServer(vaultClient(platform.env.VAULT_DO, resolved.vault.id));
  }

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
