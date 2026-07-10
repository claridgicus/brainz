/**
 * Remote MCP endpoint (Streamable HTTP): https://brainz.brownmatter.ai/mcp
 *
 * Auth split:
 * - `Authorization: Bearer bz_...` (valid) → SHA-256 → D1 api_key lookup →
 *   that key's vault DO, serving the 9 authenticated vault tools.
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
 *   claude mcp add --transport http brainz https://brainz.brownmatter.ai/mcp \
 *     --header "Authorization: Bearer bz_..."
 */
import type { RequestHandler } from "@sveltejs/kit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { apiError, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { resolveApiKey } from "$lib/server/vault-access";
import { buildMcpServer } from "$lib/server/mcp";
import { magicLinkMinter } from "$lib/server/magic-link";
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
        // Mint the human's loginUrl as a real Better Auth magic link. Its
        // origin comes from BETTER_AUTH_URL (production) or the request origin.
        createLoginLink: magicLinkMinter(platform.env, event.url.origin),
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
    const vaultId = resolved.vault.id;
    server = buildMcpServer(vaultClient(platform.env.VAULT_DO, vaultId), {
      // Mirror onboard completion into the D1 control-plane column.
      onOnboarded: async (onboardedAt) => {
        await createDb(platform.env.DB)
          .update(schema.vault)
          .set({ onboardedAt })
          .where(eq(schema.vault.id, vaultId));
      },
    });
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
