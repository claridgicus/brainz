/**
 * The remote MCP request handler, shared by the two cloud MCP endpoints:
 *
 * - `/mcp` — the DIRECTORY endpoint (what the Claude Connectors Directory and
 *   the ChatGPT directory list). OAuth 2.1 (`bzat_`) plus lazy auth, and `bz_`
 *   keys / public-vault tokens as before. With NO Authorization header it
 *   offers no callable tool: it lists the directory vault tools and answers
 *   every `tools/call` with the HTTP 401 OAuth challenge. It never hands out an
 *   API key (OpenAI forbids plugins that "collect, solicit, or process" API
 *   keys). OAuth connections never see `session_hook`
 *   (DIRECTORY_HIDDEN_TOOL_NAMES) or `claim`.
 * - `/mcp/agent` (AGENT_MCP_PATH) — the AGENT endpoint. With NO Authorization
 *   header it serves the public `signup` / `sign_in` tools (agent self-signup,
 *   Wave G); `bz_` keys and public-vault tokens work exactly as on `/mcp`. OAuth
 *   access tokens are bound to the `/mcp` resource, so they 401 here.
 *
 * Auth split (both endpoints unless noted):
 * - `Authorization: Bearer bz_...` (valid) → SHA-256 → D1 api_key lookup →
 *   that key's vault DO, serving the authenticated vault tools PLUS the
 *   cloud-only `claim` tool (CLOUD_MCP_TOOLS in @brainz/contracts).
 *   Wave M pinned decision (documented in $lib/server/vault-access): keys
 *   carry EDITOR-equivalent data-plane scope — every vault tool (reads AND
 *   writes) works over any valid key; the viewer role constrains only
 *   session surfaces, and key management stays owner-only, so no key can
 *   ever exist with less-than-editor scope. No per-tool role checks here.
 * - Bearer whose provisional owner expired unclaimed → 401 with the
 *   workspace-expired message (Wave G).
 * - Bearer matching an enabled vault's public_token_hash (public vaults) → an
 *   ANONYMOUS VIEWER on that vault: the READ tools only (search/get/related/
 *   context/list/stats — buildPublicVaultMcpServer), NO write/onboard/task/claim
 *   tools, per-IP rate-limited. Rotated/revoked/disabled token → generic 401.
 * - `Authorization: Bearer bzat_...` (Wave OA, `/mcp` only) → an OAuth 2.1
 *   access token ($lib/server/oauth): token → grant → its vault(s), acting as
 *   the signed-in user. The user's CURRENT membership role picks the surface:
 *   owner/editor get the directory vault tools, a viewer gets the read tools
 *   only. A multi-vault grant gets buildMultiVaultMcpServer instead: a
 *   required `vault` arg on every vault tool, `list_vaults`, and the role
 *   checked per call. No `claim` (an OAuth user is already a signed-in human)
 *   and no `session_hook`.
 * - Authorization header present but invalid/revoked/expired → 401. On `/mcp`
 *   every bearer 401 carries `WWW-Authenticate: Bearer ... resource_metadata=...`
 *   so OAuth clients refresh or re-authorize; `/mcp/agent` is not an OAuth
 *   resource, so its 401s carry a bare `Bearer` challenge.
 * - NO Authorization header → see the endpoint split above. No URL of any kind
 *   is ever returned — both the sign-in link and claim approval travel by
 *   EMAIL only ($lib/server/claim).
 *
 * Stateless: a fresh McpServer + transport per request (no session ids),
 * served through @hono/mcp's fetch-native StreamableHTTPTransport — chosen
 * over the Cloudflare agents SDK's McpAgent because McpAgent wants to own
 * Worker routing/DO wiring, which fights adapter-cloudflare's single compiled
 * worker; @hono/mcp drops cleanly into a SvelteKit endpoint.
 */
import type { RequestEvent } from "@sveltejs/kit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { CLOUD_MCP_TOOLS, DIRECTORY_HIDDEN_TOOL_NAMES } from "@brainz/contracts";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { apiError, HttpError, requirePlatform } from "./api-util";
import { isProductionEnv } from "./auth";
import { claimDbFrom, handleClaimTool, requestClaim } from "./claim";
import { createDb, schema } from "./db";
import { createMailer } from "./mailer";
import { guardDepsFromDb, guardMagicLinkRequest } from "./magic-link-guard";
import { magicLinkSender } from "./magic-link";
import { parseBearer } from "./api-keys";
import { resolveApiKey, WORKSPACE_EXPIRED_MESSAGE } from "./vault-access";
import { buildMcpServer, buildMultiVaultMcpServer, buildPublicVaultMcpServer } from "./mcp";
import {
  callsGatedTool,
  isAccessTokenFormat,
  issuerFor,
  resolveAccessToken,
  wwwAuthenticate,
} from "./oauth";
import {
  buildDirectoryListingMcpServer,
  buildPublicMcpServer,
  signupDepsFromDb,
} from "./public-mcp";
import { recordAndCheckPublicRead, resolvePublicVault } from "./public-vault";
import { resolveRateLimitIp } from "./rate-limit";
import { vaultClient } from "./vault-client";

/** Which cloud MCP endpoint is serving the request (see the module doc). */
export type McpSurface = "directory" | "agent";

/**
 * 401 with a Bearer challenge. On the directory endpoint `resource_metadata`
 * points at the RFC 9728 document, so a client with a dead or missing token
 * starts (or refreshes) OAuth instead of failing. The agent endpoint is not an
 * OAuth protected resource, so it gets the bare challenge.
 */
function unauthorized(
  issuer: string,
  surface: McpSurface,
  message: string,
  opts: { tokenPresented: boolean },
): Response {
  return new Response(JSON.stringify({ error: `unauthorized: ${message}` }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      // RFC 6750 §3.1: an error code only when a token was actually rejected.
      "www-authenticate":
        surface === "directory"
          ? wwwAuthenticate(issuer, opts.tokenPresented ? { invalidToken: message } : {})
          : opts.tokenPresented
            ? `Bearer error="invalid_token", error_description="${message.replace(/["\\]/g, "")}"`
            : "Bearer",
    },
  });
}

/** The directory endpoint has no public tool: every unauthenticated tools/call is gated. */
const NO_PUBLIC_TOOLS: ReadonlySet<string> = new Set();

/** The JSON-RPC body of a POST, read from a clone (the transport reads the original). */
async function peekJsonRpc(request: Request): Promise<unknown> {
  if (request.method !== "POST") return null;
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

/** Mirror onboard / sync completion into the D1 control-plane columns. */
function mirrorHooks(d1: Parameters<typeof createDb>[0], vaultId: string) {
  return {
    onOnboarded: async (onboardedAt: Date) => {
      await createDb(d1).update(schema.vault).set({ onboardedAt }).where(eq(schema.vault.id, vaultId));
    },
    onSynced: async (lastSyncedAt: Date) => {
      await createDb(d1).update(schema.vault).set({ lastSyncedAt }).where(eq(schema.vault.id, vaultId));
    },
  };
}

/** Serve one MCP request on the given cloud endpoint. */
export async function handleMcpRequest(event: RequestEvent, surface: McpSurface): Promise<Response> {
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const ip = event.request.headers.get("cf-connecting-ip") ?? "local";
  const issuer = issuerFor(platform.env.BETTER_AUTH_URL, event.url.origin);
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
  const bearerToken = parseBearer(event.request.headers.get("authorization"));
  if (event.request.headers.get("authorization") === null && surface === "directory") {
    // Lazy-auth gate (Wave OA): on the directory endpoint EVERY tools/call
    // without a token gets the HTTP 401 OAuth challenge BEFORE the SDK runs.
    // initialize and tools/list fall through to the listing server, which
    // offers no API key and no callable tool.
    if (callsGatedTool(await peekJsonRpc(event.request), NO_PUBLIC_TOOLS)) {
      return unauthorized(issuer, surface, "Authentication required for this tool", {
        tokenPresented: false,
      });
    }
    server = buildDirectoryListingMcpServer();
  } else if (event.request.headers.get("authorization") === null) {
    // Agent endpoint, absent auth → the agent self-signup server (signup +
    // sign_in). Invalid auth never lands here — it still 401s below.
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
  } else if (bearerToken !== null && isAccessTokenFormat(bearerToken)) {
    // OAuth 2.1 access token (Wave OA): one grant = one user × one client ×
    // one vault, several vaults, or all of them. The token's resource is
    // `/mcp`; the agent endpoint is not that resource.
    if (surface === "agent") {
      return unauthorized(issuer, surface, "OAuth access tokens are accepted on /mcp only", {
        tokenPresented: true,
      });
    }
    const access = await resolveAccessToken(platform.env.DB, bearerToken, new Date());
    if (!access.ok) {
      return unauthorized(
        issuer,
        surface,
        access.reason === "owner_expired"
          ? WORKSPACE_EXPIRED_MESSAGE
          : access.reason === "no_vault"
            ? "this connection covers all your vaults, and you have none yet: create or join a vault"
            : "invalid or expired access token",
        { tokenPresented: true },
      );
    }
    if (access.vaultScope === "single") {
      const [only] = access.vaults;
      const vault = vaultClient(platform.env.VAULT_DO, only.id);
      server =
        only.role === "viewer"
          ? buildPublicVaultMcpServer(vault)
          : buildMcpServer(vault, {
              ...mirrorHooks(platform.env.DB, only.id),
              // Directory surface: no session_hook (and no claim) for OAuth,
              // and onboarding/sync notices that don't steer the model.
              exclude: DIRECTORY_HIDDEN_TOOL_NAMES,
              notices: "neutral",
            });
    } else {
      // Multi-vault grant: every vault tool takes a required `vault` arg, the
      // role is checked per call, and list_vaults names the vaults.
      server = buildMultiVaultMcpServer({
        vaults: access.vaults,
        includesFutureVaults: access.vaultScope === "all",
        open: (vaultId) => ({
          client: vaultClient(platform.env.VAULT_DO, vaultId),
          hooks: mirrorHooks(platform.env.DB, vaultId),
        }),
        exclude: DIRECTORY_HIDDEN_TOOL_NAMES,
      });
    }
  } else {
    let resolved: Awaited<ReturnType<typeof resolveApiKey>>;
    try {
      resolved = await resolveApiKey(event);
    } catch (err) {
      // Wave G: expired-unclaimed owners get the actionable message, not the
      // generic one. Anything else stays a plain 401.
      if (err instanceof HttpError && err.status === 401) {
        return unauthorized(issuer, surface, err.message, { tokenPresented: true });
      }
      resolved = null;
    }
    if (!resolved) {
      // Not a valid `bz_` key. Before 401ing, try the bearer as a PUBLIC-VAULT
      // token (public vaults): a token that hashes to an enabled vault's
      // public_token_hash grants an ANONYMOUS VIEWER — the read tools only,
      // per-IP rate-limited (a public token is not a secret credential).
      const publicVault = bearerToken ? await resolvePublicVault(db, bearerToken) : null;
      if (publicVault) {
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
        const { limited } = await recordAndCheckPublicRead(db, resolvedIp.ip, new Date());
        if (limited) {
          return new Response(
            JSON.stringify({ error: "rate limited: too many public reads from this IP; slow down" }),
            { status: 429, headers: { "content-type": "application/json" } },
          );
        }
        const publicServer = buildPublicVaultMcpServer(
          vaultClient(platform.env.VAULT_DO, publicVault.id),
        );
        const publicTransport = new StreamableHTTPTransport();
        await publicServer.connect(publicTransport);
        const publicApp = new Hono();
        publicApp.all("*", (c) => publicTransport.handleRequest(c));
        try {
          return await publicApp.fetch(event.request);
        } catch (err) {
          return apiError(500, err instanceof Error ? err.message : "mcp transport error");
        }
      }
      // Unknown/rotated/revoked token → the same generic 401 as any bad bearer
      // (no existence leak — a dead public token reads like any invalid key).
      return unauthorized(
        issuer,
        surface,
        surface === "directory"
          ? "provide a Bearer bz_ API key or an OAuth access token"
          : "provide a Bearer bz_ API key",
        { tokenPresented: true },
      );
    }
    const vaultId = resolved.vault.id;
    const ownerId = resolved.vault.ownerId;
    server = buildMcpServer(vaultClient(platform.env.VAULT_DO, vaultId), {
      ...mirrorHooks(platform.env.DB, vaultId),
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
}
