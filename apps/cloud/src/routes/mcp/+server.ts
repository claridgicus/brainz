/**
 * Remote MCP endpoint (Streamable HTTP): https://brainz.brownmatter.ai/mcp
 *
 * Auth split:
 * - `Authorization: Bearer bz_...` (valid) → SHA-256 → D1 api_key lookup →
 *   that key's vault DO, serving the authenticated vault tools PLUS the
 *   cloud-only `claim` tool (CLOUD_MCP_TOOLS in @brainz/contracts).
 * - Bearer whose provisional owner expired unclaimed → 401 with the
 *   workspace-expired message (Wave G).
 * - Authorization header present but invalid/revoked → 401, exactly as before.
 * - NO Authorization header → the PUBLIC MCP server: exactly one tool,
 *   `signup` (anonymous provisional workspaces; see PUBLIC_MCP_TOOLS and
 *   $lib/server/public-mcp). No URL of any kind is ever returned — claim
 *   approval travels by EMAIL only ($lib/server/claim).
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
import { CLOUD_MCP_TOOLS } from "@brainz/contracts";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { apiError, HttpError, requirePlatform } from "$lib/server/api-util";
import { isProductionEnv } from "$lib/server/auth";
import { claimDbFrom, handleClaimTool, requestClaim } from "$lib/server/claim";
import { createDb, schema } from "$lib/server/db";
import { createMailer } from "$lib/server/mailer";
import { guardDepsFromDb, guardMagicLinkRequest } from "$lib/server/magic-link-guard";
import { magicLinkSender } from "$lib/server/magic-link";
import { resolveApiKey } from "$lib/server/vault-access";
import { buildMcpServer } from "$lib/server/mcp";
import { buildPublicMcpServer, signupDepsFromDb } from "$lib/server/public-mcp";
import { resolveRateLimitIp } from "$lib/server/rate-limit";
import { vaultClient } from "$lib/server/vault-client";

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: `unauthorized: ${message}` }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="brainz-cloud"',
    },
  });
}

const handleMcp: RequestHandler = async (event) => {
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const ip = event.request.headers.get("cf-connecting-ip") ?? "local";
  // Claim deps shared by both surfaces: approval links are EMAILED via the
  // env-selected mailer and built on the request origin (production pins
  // BETTER_AUTH_URL). Never handed back to the caller.
  const claimDeps = {
    db: claimDbFrom(db),
    mailer: createMailer(platform.env),
    origin: platform.env.BETTER_AUTH_URL || event.url.origin,
    ip,
    now: () => new Date(),
  };

  let server: McpServer;
  if (event.request.headers.get("authorization") === null) {
    // Absent auth → public server (signup tool only). Invalid auth never
    // lands here — it still 401s below.
    //
    // Fail closed on a missing cf-connecting-ip in production (audit LOW): the
    // signup rate limit is keyed on this IP, so header-less traffic must not
    // pool into one shared "local" bucket a single actor could exhaust to block
    // every other header-less signup. In dev the shared bucket is fine.
    const resolvedIp = resolveRateLimitIp(
      event.request.headers.get("cf-connecting-ip"),
      isProductionEnv(platform.env),
    );
    if (!resolvedIp.ok) {
      return new Response(
        JSON.stringify({ error: "rate limited: missing client IP; retry through the edge" }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    // The public sign_in tool emails a magic link via the same env-selected
    // mailer + origin the login page uses; the URL is never returned.
    const sendMagicLink = magicLinkSender(platform.env, event.url.origin);
    server = buildPublicMcpServer(
      signupDepsFromDb(db, {
        ip: resolvedIp.ip,
        // Supplying `email` to signup fires the same claim-request flow as the
        // claim tool; the result is intentionally dropped (claimEmailSent is
        // reported true regardless — no eligibility oracle).
        requestClaim: async ({ userId, email }) => {
          await requestClaim(claimDeps, { userId, email });
        },
        // sign_in: rate-limit exactly like the login page's magic-link request
        // (5/hour/email + 20/hour/IP, atomic/inclusive — the same durable
        // magic_link_events guard the /api/auth/sign-in/magic-link path uses),
        // then EMAIL the link. Never returns a URL; delivery is swallowed.
        requestSignIn: async ({ email }) => {
          const { throttled } = await guardMagicLinkRequest(guardDepsFromDb(db), {
            email,
            ip: resolvedIp.ip,
          });
          if (throttled) return { throttled: true };
          await sendMagicLink(email);
          return { throttled: false };
        },
      }),
    );
  } else {
    let resolved: Awaited<ReturnType<typeof resolveApiKey>>;
    try {
      resolved = await resolveApiKey(event);
    } catch (err) {
      // Wave G: expired-unclaimed owners get the actionable message, not the
      // generic one. Anything else stays a plain 401.
      if (err instanceof HttpError && err.status === 401) return unauthorized(err.message);
      resolved = null;
    }
    if (!resolved) {
      return unauthorized("provide a Bearer bz_ API key");
    }
    const vaultId = resolved.vault.id;
    const ownerId = resolved.vault.ownerId;
    server = buildMcpServer(vaultClient(platform.env.VAULT_DO, vaultId), {
      // Mirror onboard completion into the D1 control-plane column.
      onOnboarded: async (onboardedAt) => {
        await createDb(platform.env.DB)
          .update(schema.vault)
          .set({ onboardedAt })
          .where(eq(schema.vault.id, vaultId));
      },
      // Cloud-only claim tool: attach this workspace to a human's email. The
      // approval link is EMAILED — never present in the tool result.
      extraTools: CLOUD_MCP_TOOLS.map((def) => ({
        def,
        handler: (args: Record<string, unknown>) =>
          handleClaimTool(args, { ...claimDeps, ownerId }),
      })),
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
