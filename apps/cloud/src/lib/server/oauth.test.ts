import { describe, expect, it } from "vitest";
import {
  oauthAuthorizationServerMetadataSchema,
  oauthClientRegistrationResponseSchema,
  oauthErrorSchema,
  oauthProtectedResourceMetadataSchema,
  oauthTokenResponseSchema,
  type OAuthTokenResponse,
} from "@brainz/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Db } from "./db";
import { applyMigration, fakeD1, seedOwner } from "./fake-d1.testutil";
import { membersDbFrom } from "./members";
import {
  authorizationServerMetadata,
  callsGatedTool,
  createAuthorizationCode,
  fetchClientMetadataDocument,
  handleRevokeRequest,
  handleTokenRequest,
  ipInCidr,
  isAnthropicEgress,
  isDirectoryEgress,
  isOpenAiEgress,
  supersedeChildren,
  isCrossSiteFormPost,
  purgeUnusedClients,
  REGISTER_GLOBAL_LIMIT,
  REGISTER_RATE_LIMIT,
  touchClient,
  registrationThrottled,
  protectedResourceMetadata,
  readOAuthForm,
  redirectUriMatches,
  redirectUriProblem,
  registerClient,
  memberRemovalStatements,
  prepareGrantsForVaultDelete,
  resolveAccessToken,
  s256,
  validateAuthorizeRequest,
  wwwAuthenticate,
  type FetchLike,
  type VaultSelection,
} from "./oauth";

const ISSUER = "https://brainz.example";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-._~" + "A1".repeat(10);
/** The post-deploy re-backfill in apps/cloud/README.md ("Migrations 0013–0014"), verbatim. */
const REBACKFILL_SQL =
  "INSERT OR IGNORE INTO oauth_grant_vault (grant_id, vault_id) SELECT id, vault_id FROM oauth_grant g " +
  "WHERE vault_scope='single' AND vault_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM oauth_grant_vault WHERE grant_id=g.id)";
const SINGLE_V1 = { selection: { all: false, vaultIds: ["v1"] }, anchorVaultId: "v1" } as const;
const noFetch: FetchLike = async () => {
  throw new Error("unexpected fetch");
};

function setup() {
  const d1 = fakeD1();
  seedOwner(d1, "u1", "v1");
  addMember(d1, "v1", "u1", "owner");
  return d1;
}

function addMember(d1: ReturnType<typeof fakeD1>, vaultId: string, userId: string, role: string) {
  d1.db
    .prepare(`INSERT INTO vault_member (id, vault_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), vaultId, userId, role, Date.now());
}

async function authorizeParams(clientId: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: await s256(VERIFIER),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "vault offline_access",
    resource: `${ISSUER}/mcp`,
    ...overrides,
  });
}

/** Register a public client and walk authorize → code → token. */
async function connect(
  d1: ReturnType<typeof fakeD1>,
  now = new Date(),
  vaults: { selection: VaultSelection; anchorVaultId: string } = SINGLE_V1,
) {
  const client = await registerClient(
    d1,
    { redirect_uris: [CLAUDE_CALLBACK, "http://localhost/callback"], token_endpoint_auth_method: "none", client_name: "Claude" },
    now,
  );
  const v = await validateAuthorizeRequest(d1, await authorizeParams(client.client_id), ISSUER, noFetch);
  if (!v.ok) throw new Error("authorize failed");
  const code = await createAuthorizationCode(d1, { request: v.request, userId: "u1", ...vaults, now });
  const res = await handleTokenRequest(
    { db: d1, now, fetchImpl: noFetch },
    { grant_type: "authorization_code", code, code_verifier: VERIFIER, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id },
    null,
  );
  return { client, code, res, tokens: res.body as OAuthTokenResponse };
}

describe("discovery documents", () => {
  it("protected-resource metadata names /mcp and the issuer", () => {
    const prm = protectedResourceMetadata(ISSUER);
    expect(oauthProtectedResourceMetadataSchema.safeParse(prm).success).toBe(true);
    expect(prm.resource).toBe(`${ISSUER}/mcp`);
    expect(prm.authorization_servers).toEqual([ISSUER]);
  });

  it("AS metadata advertises S256, DCR, CIMD and public clients", () => {
    const as = authorizationServerMetadata(ISSUER);
    expect(oauthAuthorizationServerMetadataSchema.safeParse(as).success).toBe(true);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("the no-token 401 challenge has no error code (RFC 6750 §3.1)", () => {
    const h = wwwAuthenticate(ISSUER);
    expect(h).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="vault"`,
    );
    expect(h).not.toContain("error");
  });

  it("a rejected token's challenge carries invalid_token (quotes stripped)", () => {
    const h = wwwAuthenticate(ISSUER, { invalidToken: 'expired "token"' });
    expect(h).toMatch(/^Bearer error="invalid_token", error_description="expired token"/);
    expect(h).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe("redirect URIs", () => {
  it("registration accepts https and loopback http only", () => {
    expect(redirectUriProblem(CLAUDE_CALLBACK)).toBeNull();
    expect(redirectUriProblem("http://localhost:3118/callback")).toBeNull();
    expect(redirectUriProblem("http://127.0.0.1/callback")).toBeNull();
    expect(redirectUriProblem("http://[::1]:9/cb")).toBeNull();
    expect(redirectUriProblem("http://evil.example/cb")).not.toBeNull();
    expect(redirectUriProblem("https://x.example/cb#frag")).not.toBeNull();
    expect(redirectUriProblem("javascript:alert(1)")).not.toBeNull();
    expect(redirectUriProblem("not a url")).not.toBeNull();
  });

  it("matches exactly, except loopback ports", () => {
    const reg = [CLAUDE_CALLBACK, "http://localhost/callback", "http://127.0.0.1/callback"];
    expect(redirectUriMatches(reg, CLAUDE_CALLBACK)).toBe(true);
    expect(redirectUriMatches(reg, "http://localhost:3118/callback")).toBe(true);
    expect(redirectUriMatches(reg, "http://127.0.0.1:55555/callback")).toBe(true);
    expect(redirectUriMatches(reg, "http://localhost:3118/other")).toBe(false);
    expect(redirectUriMatches(reg, "https://claude.ai:444/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriMatches(reg, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(redirectUriMatches(reg, "http://localhost.evil.example:3118/callback")).toBe(false);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client with no secret", async () => {
    const d1 = fakeD1();
    const res = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, new Date());
    expect(oauthClientRegistrationResponseSchema.safeParse(res).success).toBe(true);
    expect(res.client_id).toMatch(/^bzc_/);
    expect(res.client_secret).toBeUndefined();
    expect(res.grant_types).toContain("refresh_token");
  });

  it("issues a hashed secret to confidential clients (default method)", async () => {
    const d1 = fakeD1();
    const res = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK] }, new Date());
    expect(res.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(res.client_secret).toMatch(/^bzcs_/);
    const row = d1.db.prepare(`SELECT client_secret_hash FROM oauth_client`).get() as { client_secret_hash: string };
    expect(row.client_secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects bad redirect URIs and unsupported grants", async () => {
    const d1 = fakeD1();
    await expect(registerClient(d1, { redirect_uris: ["http://evil.example/cb"] }, new Date())).rejects.toMatchObject({
      code: "invalid_redirect_uri",
    });
    await expect(
      registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], grant_types: ["client_credentials"] }, new Date()),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
    await expect(registerClient(d1, { redirect_uris: [] }, new Date())).rejects.toMatchObject({
      code: "invalid_client_metadata",
    });
  });

  it("caps registrations at 5 redirect URIs of 512 chars", async () => {
    const d1 = fakeD1();
    const six = Array.from({ length: 6 }, (_, i) => `https://x.example/cb${i}`);
    await expect(registerClient(d1, { redirect_uris: six }, new Date())).rejects.toMatchObject({
      code: "invalid_client_metadata",
    });
    const long = `https://x.example/${"a".repeat(500)}`;
    await expect(registerClient(d1, { redirect_uris: [long] }, new Date())).rejects.toMatchObject({
      code: "invalid_client_metadata",
    });
    await expect(
      registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], logo_uri: `https://x/${"a".repeat(600)}` }, new Date()),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
  });

  it("refuses an over-limit bucket without recording another row", async () => {
    const d1 = fakeD1();
    const now = new Date();
    for (let i = 0; i <= REGISTER_RATE_LIMIT; i++) await registrationThrottled(d1, "198.51.100.1", now);
    const rows = () => (d1.db.prepare(`SELECT COUNT(*) AS n FROM oauth_register_events`).get() as { n: number }).n;
    const before = rows();
    for (let i = 0; i < 50; i++) expect(await registrationThrottled(d1, "198.51.100.1", now)).toBe(true);
    expect(rows()).toBe(before);
  });

  it("caps registrations globally across buckets (non-Anthropic)", async () => {
    const d1 = fakeD1();
    const now = new Date();
    const insert = d1.db.prepare(`INSERT INTO oauth_register_events (id, ip, created_at) VALUES (?, ?, ?)`);
    d1.db.transaction(() => {
      for (let i = 0; i < REGISTER_GLOBAL_LIMIT; i++) insert.run(`e${i}`, `bucket-${i}`, now.getTime());
    })();
    expect(REGISTER_GLOBAL_LIMIT).toBeGreaterThanOrEqual(20_000);
    expect(await registrationThrottled(d1, "192.0.2.200", now)).toBe(true);
    // Anthropic's egress is never subject to it.
    expect(await registrationThrottled(d1, "160.79.105.3", now)).toBe(false);
  });

  it("limits registrations per IP, exempting Anthropic's egress range", async () => {
    const d1 = fakeD1();
    const now = new Date();
    for (let i = 0; i < REGISTER_RATE_LIMIT; i++) {
      expect(await registrationThrottled(d1, "203.0.113.9", now)).toBe(false);
    }
    expect(await registrationThrottled(d1, "203.0.113.9", now)).toBe(true);
    expect(await registrationThrottled(d1, "203.0.113.10", now)).toBe(false);
    // An hour later the window has moved on.
    expect(await registrationThrottled(d1, "203.0.113.9", new Date(now.getTime() + 61 * 60 * 1000))).toBe(false);
    for (let i = 0; i < REGISTER_RATE_LIMIT * 3; i++) {
      expect(await registrationThrottled(d1, "160.79.104.17", now)).toBe(false);
    }
  });

  it("buckets IPv6 registrations by /48, so rotating /64s doesn't multiply the limit", async () => {
    const d1 = fakeD1();
    const now = new Date();
    for (let i = 0; i < REGISTER_RATE_LIMIT; i++) {
      // A different /64 (and address) inside 2001:db8:aa::/48 every time.
      expect(await registrationThrottled(d1, `2001:db8:aa:${i.toString(16)}::1`, now)).toBe(false);
    }
    expect(await registrationThrottled(d1, "2001:db8:aa:ffff::9", now)).toBe(true);
    // A different /48 is a different bucket.
    expect(await registrationThrottled(d1, "2001:db8:ab::1", now)).toBe(false);
  });

  it("exempts OpenAI's published ChatGPT egress from the DCR limits", async () => {
    const d1 = fakeD1();
    const now = new Date();
    // 100.31.168.162/32 is in the openai-egress snapshot.
    expect(isOpenAiEgress("100.31.168.162")).toBe(true);
    for (let i = 0; i < REGISTER_RATE_LIMIT * 3; i++) {
      expect(await registrationThrottled(d1, "100.31.168.162", now)).toBe(false);
    }
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM oauth_register_events`).get()).toEqual({ n: 0 });
  });

  it("matches IPv4 and IPv6 CIDRs", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("104.192.219.207", "104.192.219.204/30")).toBe(true);
    expect(ipInCidr("104.192.219.208", "104.192.219.204/30")).toBe(false);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("2001:db8::1", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("999.1.1.1", "0.0.0.0/0")).toBe(false);
    expect(isOpenAiEgress("192.0.2.1")).toBe(false);
    expect(isDirectoryEgress("160.79.110.1")).toBe(true);
    expect(isDirectoryEgress("100.31.168.162")).toBe(true);
    expect(isDirectoryEgress("192.0.2.1")).toBe(false);
  });

  it("recognises exactly 160.79.104.0/21 as Anthropic egress", () => {
    expect(isAnthropicEgress("160.79.104.0")).toBe(true);
    expect(isAnthropicEgress("160.79.111.255")).toBe(true);
    expect(isAnthropicEgress("160.79.103.255")).toBe(false);
    expect(isAnthropicEgress("160.79.112.0")).toBe(false);
    expect(isAnthropicEgress("2001:db8::1")).toBe(false);
    expect(isAnthropicEgress("local")).toBe(false);
  });

  it("purges grantless clients only after 30 idle days, counting authorize use", async () => {
    const d1 = setup();
    const day = 24 * 60 * 60 * 1000;
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * day);
    const reg = (when: Date) =>
      registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, when);
    const dayOld = await reg(ago(2)); // cached by e.g. Claude Code: must survive
    const stale = await reg(ago(31));
    const staleButUsed = await reg(ago(40));
    await touchClient(d1, staleButUsed.client_id, ago(3));
    const { client: connected } = await connect(d1, ago(45));
    // A client whose only grant was cascade-deleted with its vault.
    const orphaned = await reg(ago(10));
    d1.db.prepare(`INSERT INTO oauth_register_events (id, ip, created_at) VALUES ('e1', '1.2.3.4', ?)`).run(ago(1).getTime());
    await purgeUnusedClients(d1, now);
    const ids = (d1.db.prepare(`SELECT client_id FROM oauth_client`).all() as { client_id: string }[]).map((r) => r.client_id);
    expect(ids).toContain(dayOld.client_id);
    expect(ids).toContain(staleButUsed.client_id);
    expect(ids).toContain(connected.client_id);
    expect(ids).toContain(orphaned.client_id);
    expect(ids).not.toContain(stale.client_id);
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM oauth_register_events`).get()).toEqual({ n: 0 });
  });

});

describe("client ID metadata documents", () => {
  const URL_ID = "https://claude.ai/oauth/claude-code-client-metadata";
  const doc = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      client_id: URL_ID,
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
      ...over,
    });
  const serving = (body: string, status = 200, type = "application/json"): FetchLike => async () =>
    new Response(body, { status, headers: { "content-type": type } });

  it("accepts a self-consistent document and names the host", async () => {
    const c = await fetchClientMetadataDocument(URL_ID, serving(doc()));
    expect(c).toMatchObject({ kind: "cimd", displayName: "claude.ai", selfAsserted: false, authMethod: "none" });
  });

  it("rejects mismatched ids, redirects, bad URIs, confidential methods and oversize docs", async () => {
    expect(await fetchClientMetadataDocument(URL_ID, serving(doc({ client_id: "https://other.example/x" })))).toBeNull();
    expect(await fetchClientMetadataDocument(URL_ID, serving(doc(), 302))).toBeNull();
    expect(await fetchClientMetadataDocument(URL_ID, serving(doc({ redirect_uris: ["http://evil.example/cb"] })))).toBeNull();
    expect(
      await fetchClientMetadataDocument(URL_ID, serving(doc({ token_endpoint_auth_method: "client_secret_basic" }))),
    ).toBeNull();
    expect(await fetchClientMetadataDocument(URL_ID, serving(doc({ pad: "x".repeat(20_000) })))).toBeNull();
    expect(await fetchClientMetadataDocument(URL_ID, serving("not json"))).toBeNull();
    expect(await fetchClientMetadataDocument(URL_ID, serving(doc(), 200, "text/html"))).toBeNull();
  });

  it("streams the body and gives up past 16 KB without buffering it (no content-length)", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new Uint8Array(4096).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchEndless: FetchLike = async () =>
      new Response(endless, { status: 200, headers: { "content-type": "application/json" } });
    expect(await fetchClientMetadataDocument(URL_ID, fetchEndless)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("never fetches IP-literal, localhost or non-https ids", async () => {
    for (const id of ["https://127.0.0.1/meta", "https://localhost/meta", "http://claude.ai/meta", "https://[::1]/meta"]) {
      expect(await fetchClientMetadataDocument(id, noFetch)).toBeNull();
    }
  });

  it("is resolved at authorize time for a URL client_id", async () => {
    const d1 = fakeD1();
    const params = await authorizeParams(URL_ID, { redirect_uri: "http://localhost:4242/callback" });
    const v = await validateAuthorizeRequest(d1, params, ISSUER, serving(doc()));
    expect(v.ok).toBe(true);
  });
});

describe("authorize validation", () => {
  it("never redirects for an unknown client or unregistered redirect", async () => {
    const d1 = fakeD1();
    const unknown = await validateAuthorizeRequest(d1, await authorizeParams("bzc_nope"), ISSUER, noFetch);
    expect(unknown).toMatchObject({ ok: false, fatal: true });
    const client = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, new Date());
    const bad = await validateAuthorizeRequest(
      d1,
      await authorizeParams(client.client_id, { redirect_uri: "https://evil.example/cb" }),
      ISSUER,
      noFetch,
    );
    expect(bad).toMatchObject({ ok: false, fatal: true });
  });

  it("bounces request errors back to the client with state and iss", async () => {
    const d1 = fakeD1();
    const client = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, new Date());
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: "" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://elsewhere.example/mcp" }, "invalid_target"],
    ];
    for (const [over, error] of cases) {
      const v = await validateAuthorizeRequest(d1, await authorizeParams(client.client_id, over), ISSUER, noFetch);
      if (v.ok || v.fatal) throw new Error(`expected a bounce for ${JSON.stringify(over)}`);
      const u = new URL(v.redirectTo);
      expect(u.origin + u.pathname).toBe(CLAUDE_CALLBACK);
      expect(u.searchParams.get("error")).toBe(error);
      expect(u.searchParams.get("state")).toBe("st-1");
      expect(u.searchParams.get("iss")).toBe(ISSUER);
    }
  });

  it("never bounces from the GET: request errors carry a redirect only the consent action may use", async () => {
    // The page load renders every invalid request (see authorize/+page.server.ts);
    // validateAuthorizeRequest still computes the bounce for the POST actions.
    const d1 = fakeD1();
    const evil = await registerClient(d1, { redirect_uris: ["https://evil.example/x"], token_endpoint_auth_method: "none" }, new Date());
    const v = await validateAuthorizeRequest(
      d1,
      await authorizeParams(evil.client_id, { redirect_uri: "https://evil.example/x", response_type: "bad" }),
      ISSUER,
      noFetch,
    );
    expect(v).toMatchObject({ ok: false, fatal: false });
  });

  it("defaults the redirect when exactly one is registered", async () => {
    const d1 = fakeD1();
    const client = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, new Date());
    const params = await authorizeParams(client.client_id);
    params.delete("redirect_uri");
    const v = await validateAuthorizeRequest(d1, params, ISSUER, noFetch);
    expect(v.ok && v.request.redirectUri).toBe(CLAUDE_CALLBACK);
    expect(v.ok && v.request.redirectUriExplicit).toBe(false);
  });
});

describe("token endpoint", () => {
  it("exchanges a code for a Bearer pair bound to the vault", async () => {
    const d1 = setup();
    const { res, tokens } = await connect(d1);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(oauthTokenResponseSchema.safeParse(tokens).success).toBe(true);
    const access = await resolveAccessToken(d1, tokens.access_token, new Date());
    expect(access).toMatchObject({
      ok: true,
      userId: "u1",
      vaultScope: "single",
      vaults: [{ id: "v1", slug: "v1", role: "owner", ownerId: "u1" }],
    });
    // Hashed at rest: no plaintext token anywhere in the table.
    const rows = d1.db.prepare(`SELECT token_hash FROM oauth_token`).all() as { token_hash: string }[];
    expect(rows.some((r) => r.token_hash === tokens.access_token)).toBe(false);
  });

  it("burns a code on replay and revokes the grant it produced", async () => {
    const d1 = setup();
    const { client, code, tokens } = await connect(d1);
    const replay = await handleTokenRequest(
      { db: d1, now: new Date(), fetchImpl: noFetch },
      { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: client.client_id },
      null,
    );
    expect(replay.status).toBe(400);
    expect(replay.body).toMatchObject({ error: "invalid_grant" });
    expect((await resolveAccessToken(d1, tokens.access_token, new Date())).ok).toBe(false);
  });

  it("rejects a wrong verifier, wrong redirect, expired code and another client", async () => {
    const d1 = setup();
    const now = new Date();
    const client = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, now);
    const other = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, now);
    const v = await validateAuthorizeRequest(d1, await authorizeParams(client.client_id), ISSUER, noFetch);
    if (!v.ok) throw new Error("authorize failed");
    const freshCode = () => createAuthorizationCode(d1, { request: v.request, userId: "u1", ...SINGLE_V1, now });
    const deps = { db: d1, now, fetchImpl: noFetch };
    const base = {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code_verifier: VERIFIER,
      redirect_uri: CLAUDE_CALLBACK,
    };

    const wrongVerifier = await handleTokenRequest(deps, { ...base, code: await freshCode(), code_verifier: "w".repeat(43) }, null);
    expect(wrongVerifier.body).toMatchObject({ error: "invalid_grant" });
    const wrongRedirect = await handleTokenRequest(deps, { ...base, code: await freshCode(), redirect_uri: "https://x.example/cb" }, null);
    expect(wrongRedirect.body).toMatchObject({ error: "invalid_grant" });
    const otherClient = await handleTokenRequest(deps, { ...base, code: await freshCode(), client_id: other.client_id }, null);
    expect(otherClient.body).toMatchObject({ error: "invalid_grant" });
    const late = await handleTokenRequest(
      { ...deps, now: new Date(now.getTime() + 6 * 60 * 1000) },
      { ...base, code: await freshCode() },
      null,
    );
    expect(late.body).toMatchObject({ error: "invalid_grant" });
    const noPkce = await handleTokenRequest(deps, { ...base, code: await freshCode(), code_verifier: "" }, null);
    expect(noPkce.body).toMatchObject({ error: "invalid_request" });
    const noRedirect = await handleTokenRequest(
      deps,
      { grant_type: "authorization_code", client_id: client.client_id, code_verifier: VERIFIER, code: await freshCode() },
      null,
    );
    expect(noRedirect.body).toMatchObject({ error: "invalid_request" });
    for (const r of [wrongVerifier, wrongRedirect, otherClient, late, noPkce, noRedirect]) {
      expect(oauthErrorSchema.safeParse(r.body).success).toBe(true);
    }
  });

  it("omitting redirect_uri is fine when the authorize request omitted it too", async () => {
    const d1 = setup();
    const now = new Date();
    const client = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, now);
    const params = await authorizeParams(client.client_id);
    params.delete("redirect_uri");
    const v = await validateAuthorizeRequest(d1, params, ISSUER, noFetch);
    if (!v.ok) throw new Error("authorize failed");
    const code = await createAuthorizationCode(d1, { request: v.request, userId: "u1", ...SINGLE_V1, now });
    const res = await handleTokenRequest(
      { db: d1, now, fetchImpl: noFetch },
      { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: client.client_id },
      null,
    );
    expect(res.status).toBe(200);
  });

  it("returns invalid_client, not a 500, for a malformed Basic header", async () => {
    const d1 = setup();
    const deps = { db: d1, now: new Date(), fetchImpl: noFetch };
    for (const header of [`Basic ${btoa("%E0%A4%A:secret")}`, `Basic ${btoa("id:%zz")}`, "Basic !!!not-base64", `Basic ${btoa("nocolon")}`]) {
      const res = await handleTokenRequest(deps, { grant_type: "authorization_code" }, header);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "invalid_client" });
    }
  });

  describe("refresh grace window (token family)", () => {
    async function family() {
      const d1 = setup();
      const { client, tokens } = await connect(d1);
      const t0 = Date.now();
      const at = (ms: number) => ({ db: d1, now: new Date(t0 + ms), fetchImpl: noFetch });
      const refresh = (token: string, ms: number) =>
        handleTokenRequest(at(ms), { grant_type: "refresh_token", refresh_token: token, client_id: client.client_id }, null);
      const live = async (access: string, ms: number) => (await resolveAccessToken(d1, access, new Date(t0 + ms))).ok;
      return { d1, tokens, refresh, live };
    }

    it("a retry inside the window gets a new pair and supersedes the first one", async () => {
      const { tokens, refresh, live } = await family();
      const a = (await refresh(tokens.refresh_token, 0)).body as OAuthTokenResponse;
      const retry = await refresh(tokens.refresh_token, 30_000);
      expect(retry.status).toBe(200);
      const b = retry.body as OAuthTokenResponse;
      // Exactly one live chain: the retry's pair. The first pair is superseded.
      expect(await live(b.access_token, 30_000)).toBe(true);
      expect(await live(a.access_token, 30_000)).toBe(false);
      // The surviving chain keeps working.
      expect((await refresh(b.refresh_token, 40_000)).status).toBe(200);
    });

    it("presenting a superseded sibling later is reuse and revokes the grant", async () => {
      const { tokens, refresh, live } = await family();
      const legit = (await refresh(tokens.refresh_token, 0)).body as OAuthTokenResponse;
      // A thief replays the stolen parent inside the window…
      const thief = (await refresh(tokens.refresh_token, 10_000)).body as OAuthTokenResponse;
      expect(await live(thief.access_token, 10_000)).toBe(true);
      // …and the legitimate client's next refresh trips reuse detection.
      const next = await refresh(legit.refresh_token, 20_000);
      expect(next.body).toMatchObject({ error: "invalid_grant" });
      expect(await live(thief.access_token, 20_000)).toBe(false);
      expect((await refresh(thief.refresh_token, 21_000)).body).toMatchObject({ error: "invalid_grant" });
    });

    it("no grace once the chain has moved on past the token", async () => {
      const { tokens, refresh, live } = await family();
      const a = (await refresh(tokens.refresh_token, 0)).body as OAuthTokenResponse;
      const c = (await refresh(a.refresh_token, 5_000)).body as OAuthTokenResponse;
      const replay = await refresh(tokens.refresh_token, 10_000);
      expect(replay.body).toMatchObject({ error: "invalid_grant" });
      expect(await live(c.access_token, 10_000)).toBe(false);
    });

    it("repeated retries never leave more than one live pair", async () => {
      const { d1, tokens, refresh } = await family();
      for (let i = 0; i < 5; i++) expect((await refresh(tokens.refresh_token, i * 1000)).status).toBe(200);
      const liveRefresh = d1.db
        .prepare(`SELECT COUNT(*) AS n FROM oauth_token WHERE kind = 'refresh' AND used_at IS NULL AND revoked_at IS NULL`)
        .get() as { n: number };
      expect(liveRefresh.n).toBe(1);
    });

    it("first-use and grace issuance interleaved: the last insert wins, never two live chains", async () => {
      const d1 = setup();
      const { client, tokens } = await connect(d1);
      // X = the first-use refresh, held just before it inserts its pair.
      let reached!: () => void;
      const atInsert = new Promise<void>((r) => (reached = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const held: typeof d1 = {
        ...d1,
        prepare(query: string) {
          const stmt = d1.prepare(query);
          return {
            bind(...values: unknown[]) {
              const bound = stmt.bind(...values);
              return {
                first: <T>() => bound.first<T>(),
                run: async () => {
                  if (query.trimStart().startsWith("INSERT INTO oauth_token")) {
                    reached();
                    await gate;
                  }
                  return bound.run();
                },
              };
            },
          };
        },
      };
      const form = { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id };
      const now = new Date();
      const x = handleTokenRequest({ db: held, now, fetchImpl: noFetch }, form, null);
      await atInsert; // X has consumed the token and is about to insert P1.
      // Y = a retry of the same token: grace path inserts P2 first.
      const y = await handleTokenRequest({ db: d1, now, fetchImpl: noFetch }, form, null);
      expect(y.status).toBe(200);
      release();
      expect((await x).status).toBe(200);
      const live = (kind: string) =>
        (
          d1.db
            .prepare(
              `SELECT COUNT(*) AS n FROM oauth_token WHERE kind = ? AND parent_hash IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL`,
            )
            .get(kind) as { n: number }
        ).n;
      expect(live("refresh")).toBe(1);
      expect(live("access")).toBe(1);
      // The survivor is X's pair (last insert wins).
      const xPair = (await x).body as OAuthTokenResponse;
      expect((await resolveAccessToken(d1, xPair.access_token, now)).ok).toBe(true);
      expect((await resolveAccessToken(d1, (y.body as OAuthTokenResponse).access_token, now)).ok).toBe(false);
    });

    it("superseding a sibling also kills the chain that grew from it", async () => {
      const d1 = setup();
      const { tokens } = await connect(d1);
      const grant = (d1.db.prepare(`SELECT id FROM oauth_grant`).get() as { id: string }).id;
      const ins = d1.db.prepare(
        `INSERT INTO oauth_token (token_hash, grant_id, kind, created_at, expires_at, parent_hash) VALUES (?, ?, 'refresh', 0, 9e15, ?)`,
      );
      // P → A → B → C, and P → K (the pair being kept).
      ins.run("A", grant, "P");
      ins.run("B", grant, "A");
      ins.run("C", grant, "B");
      ins.run("K", grant, "P");
      ins.run("K-access", grant, "P");
      await supersedeChildren(d1, "P", ["K", "K-access"], new Date());
      const revoked = (h: string) =>
        (d1.db.prepare(`SELECT revoked_at FROM oauth_token WHERE token_hash = ?`).get(h) as { revoked_at: number | null })
          .revoked_at !== null;
      expect(["A", "B", "C"].map(revoked)).toEqual([true, true, true]);
      expect(revoked("K")).toBe(false);
      expect(revoked("K-access")).toBe(false);
      void tokens;
    });

    it("past the window, re-presenting the rotated token is theft", async () => {
      const { tokens, refresh, live } = await family();
      const a = (await refresh(tokens.refresh_token, 0)).body as OAuthTokenResponse;
      expect((await refresh(tokens.refresh_token, 61_000)).body).toMatchObject({ error: "invalid_grant" });
      expect(await live(a.access_token, 61_000)).toBe(false);
    });
  });

  it("reads the grace override from env, defaulting to 60 s and capped at 300 s", async () => {
    const { refreshGraceFromEnv } = await import("./oauth");
    expect(refreshGraceFromEnv(undefined)).toBe(60);
    expect(refreshGraceFromEnv("")).toBe(60);
    expect(refreshGraceFromEnv("nope")).toBe(60);
    expect(refreshGraceFromEnv("-1")).toBe(60);
    expect(refreshGraceFromEnv("3")).toBe(3);
    // Clamped: a long window would make the family-split check meaningless.
    expect(refreshGraceFromEnv("1000")).toBe(300);
  });

  it("rotates refresh tokens and treats reuse as theft", async () => {
    const d1 = setup();
    const { client, tokens } = await connect(d1);
    const deps = { db: d1, now: new Date(), fetchImpl: noFetch };
    // Reuse is judged a minute later, past the race grace window.
    const later = { ...deps, now: new Date(deps.now.getTime() + 61_000) };
    const refresh = (token: string, clientId = client.client_id, d = deps) =>
      handleTokenRequest(d, { grant_type: "refresh_token", refresh_token: token, client_id: clientId }, null);

    const second = await refresh(tokens.refresh_token);
    expect(second.status).toBe(200);
    const pair = second.body as OAuthTokenResponse;
    expect(pair.refresh_token).not.toBe(tokens.refresh_token);
    expect((await resolveAccessToken(d1, pair.access_token, new Date())).ok).toBe(true);

    const reuse = await refresh(tokens.refresh_token, client.client_id, later);
    expect(reuse.body).toMatchObject({ error: "invalid_grant" });
    // The whole grant is dead, including the pair issued by the rotation.
    expect((await resolveAccessToken(d1, pair.access_token, later.now)).ok).toBe(false);
    expect((await refresh(pair.refresh_token, client.client_id, later)).body).toMatchObject({ error: "invalid_grant" });
  });

  it("a refresh token presented by another client fails without burning the grant", async () => {
    const d1 = setup();
    const { client, tokens } = await connect(d1);
    const other = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, new Date());
    const deps = { db: d1, now: new Date(), fetchImpl: noFetch };
    const stolen = await handleTokenRequest(
      deps,
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other.client_id },
      null,
    );
    expect(stolen.body).toMatchObject({ error: "invalid_grant" });
    const legit = await handleTokenRequest(
      deps,
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id },
      null,
    );
    expect(legit.status).toBe(200);
  });

  it("authenticates confidential clients (Basic and post) and rejects missing secrets", async () => {
    const d1 = setup();
    const now = new Date();
    const client = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK] }, now);
    const v = await validateAuthorizeRequest(d1, await authorizeParams(client.client_id), ISSUER, noFetch);
    if (!v.ok) throw new Error("authorize failed");
    const deps = { db: d1, now, fetchImpl: noFetch };
    const code = await createAuthorizationCode(d1, { request: v.request, userId: "u1", ...SINGLE_V1, now });
    const form = {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: client.client_id,
      redirect_uri: CLAUDE_CALLBACK,
    };

    const missing = await handleTokenRequest(deps, form, null);
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ error: "invalid_client" });
    const wrongBasic = await handleTokenRequest(deps, {}, `Basic ${btoa(`${client.client_id}:nope`)}`);
    expect(wrongBasic.status).toBe(401);
    expect(wrongBasic.headers["www-authenticate"]).toMatch(/^Basic/);

    const basic = await handleTokenRequest(
      deps,
      { ...form, client_id: "" },
      `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`,
    );
    expect(basic.status).toBe(200);
    const code2 = await createAuthorizationCode(d1, { request: v.request, userId: "u1", ...SINGLE_V1, now });
    const post = await handleTokenRequest(deps, { ...form, code: code2, client_secret: client.client_secret! }, null);
    expect(post.status).toBe(200);
  });

  it("rejects unknown grant types", async () => {
    const d1 = setup();
    const { client } = await connect(d1);
    const res = await handleTokenRequest(
      { db: d1, now: new Date(), fetchImpl: noFetch },
      { grant_type: "client_credentials", client_id: client.client_id },
      null,
    );
    expect(res.body).toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("access resolution", () => {
  it("follows the user's current membership", async () => {
    const d1 = setup();
    const { client, tokens } = await connect(d1);
    d1.db.prepare(`UPDATE vault_member SET role = 'viewer' WHERE user_id = 'u1'`).run();
    expect(await resolveAccessToken(d1, tokens.access_token, new Date())).toMatchObject({
      ok: true,
      vaults: [{ id: "v1", role: "viewer" }],
    });
    d1.db.prepare(`DELETE FROM vault_member WHERE user_id = 'u1'`).run();
    expect(await resolveAccessToken(d1, tokens.access_token, new Date())).toEqual({ ok: false, reason: "invalid" });
    const refresh = await handleTokenRequest(
      { db: d1, now: new Date(), fetchImpl: noFetch },
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id },
      null,
    );
    expect(refresh.body).toMatchObject({ error: "invalid_grant" });
  });

  it("expires access tokens after an hour and honours provisional-owner expiry", async () => {
    const d1 = setup();
    const { tokens } = await connect(d1);
    const later = new Date(Date.now() + 61 * 60 * 1000);
    expect((await resolveAccessToken(d1, tokens.access_token, later)).ok).toBe(false);
    d1.db.prepare(`UPDATE user SET expires_at = 1000 WHERE id = 'u1'`).run();
    expect(await resolveAccessToken(d1, tokens.access_token, new Date())).toEqual({ ok: false, reason: "owner_expired" });
  });

  it("rejects malformed and API-key-shaped tokens without a lookup", async () => {
    const d1 = setup();
    expect((await resolveAccessToken(d1, `bz_${"a".repeat(32)}`, new Date())).ok).toBe(false);
    expect((await resolveAccessToken(d1, "bzat_short", new Date())).ok).toBe(false);
  });

  it("revocation kills the grant and always answers 200", async () => {
    const d1 = setup();
    const { client, tokens } = await connect(d1);
    const deps = { db: d1, now: new Date(), fetchImpl: noFetch };
    const unknown = await handleRevokeRequest(deps, { token: "bzat_nothing", client_id: client.client_id }, null);
    expect(unknown.status).toBe(200);
    const res = await handleRevokeRequest(deps, { token: tokens.refresh_token, client_id: client.client_id }, null);
    expect(res.status).toBe(200);
    expect((await resolveAccessToken(d1, tokens.access_token, new Date())).ok).toBe(false);
  });
});

describe("lazy-auth gate", () => {
  const PUBLIC = new Set(["signup", "sign_in"]);
  const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

  it("flags gated tool calls only", () => {
    expect(callsGatedTool(call("search_concepts"), PUBLIC)).toBe(true);
    expect(callsGatedTool(call("signup"), PUBLIC)).toBe(false);
    expect(callsGatedTool({ jsonrpc: "2.0", id: 1, method: "tools/list" }, PUBLIC)).toBe(false);
    expect(callsGatedTool({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, PUBLIC)).toBe(false);
    expect(callsGatedTool([call("sign_in"), call("get_context")], PUBLIC)).toBe(true);
    expect(callsGatedTool(null, PUBLIC)).toBe(false);
    expect(callsGatedTool("garbage", PUBLIC)).toBe(false);
  });
});

describe("cross-site form check (hooks)", () => {
  const url = new URL("https://brainz.example/oauth/authorize?x=1");
  const req = (method: string, type: string | null, origin: string | null, path = "/oauth/authorize") => {
    const headers: Record<string, string> = {};
    if (type) headers["content-type"] = type;
    if (origin) headers.origin = origin;
    return [new Request(`https://brainz.example${path}`, { method, headers, body: method === "GET" ? undefined : "a=1" }), new URL(`https://brainz.example${path}`)] as const;
  };

  it("blocks cross-site and origin-less form posts like SvelteKit does", () => {
    expect(isCrossSiteFormPost(...req("POST", "application/x-www-form-urlencoded", "https://evil.example"))).toBe(true);
    expect(isCrossSiteFormPost(...req("POST", "multipart/form-data; boundary=x", null))).toBe(true);
    expect(isCrossSiteFormPost(...req("POST", "text/plain", null))).toBe(true);
  });

  it("allows same-origin forms, JSON, GETs and the OAuth token/revoke endpoints", () => {
    expect(isCrossSiteFormPost(...req("POST", "application/x-www-form-urlencoded", url.origin))).toBe(false);
    expect(isCrossSiteFormPost(...req("POST", "application/json", null))).toBe(false);
    expect(isCrossSiteFormPost(...req("GET", null, null))).toBe(false);
    expect(isCrossSiteFormPost(...req("POST", "application/x-www-form-urlencoded", null, "/oauth/token"))).toBe(false);
    expect(isCrossSiteFormPost(...req("POST", "application/x-www-form-urlencoded", null, "/oauth/revoke"))).toBe(false);
    expect(isCrossSiteFormPost(...req("POST", "application/x-www-form-urlencoded", null, "/oauth/register"))).toBe(true);
  });
});

describe("readOAuthForm", () => {
  it("parses form-encoded and JSON bodies", async () => {
    const form = await readOAuthForm(
      new Request("https://x/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=a%2Bb",
      }),
    );
    expect(form).toEqual({ grant_type: "authorization_code", code: "a+b" });
    const json = await readOAuthForm(
      new Request("https://x/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", n: 1 }),
      }),
    );
    expect(json).toEqual({ grant_type: "refresh_token" });
  });
});

describe("multi-vault grants", () => {
  /** v1 (u1 owns, "Alpha"), v2 (u2 owns, u1 viewer, "Beta"), v3 (u1 owns, "Gamma"). */
  function multiSetup() {
    const d1 = setup();
    seedOwner(d1, "u2", "v2");
    addMember(d1, "v2", "u2", "owner");
    addMember(d1, "v2", "u1", "viewer");
    d1.db
      .prepare(`INSERT INTO vault (id, owner_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run("v3", "u1", "gamma", "Gamma", Date.now());
    addMember(d1, "v3", "u1", "owner");
    d1.db.prepare(`UPDATE vault SET name = 'Alpha' WHERE id = 'v1'`).run();
    d1.db.prepare(`UPDATE vault SET name = 'Beta' WHERE id = 'v2'`).run();
    return d1;
  }
  const pick = (...vaultIds: string[]) => ({ selection: { all: false, vaultIds }, anchorVaultId: vaultIds[0] });
  const ALL = { selection: { all: true, vaultIds: [] }, anchorVaultId: "v1" };
  const ids = async (d1: ReturnType<typeof fakeD1>, token: string, now = new Date()) => {
    const a = await resolveAccessToken(d1, token, now);
    return a.ok ? a.vaults.map((v) => `${v.id}:${v.role}`) : a.reason;
  };
  // Exactly what members.ts deleteMember and DELETE /api/vaults/:id run.
  const removeMember = (d1: ReturnType<typeof fakeD1>, vaultId: string, userId: string) =>
    d1.batch(memberRemovalStatements(d1, { vaultId, userId, now: new Date() }));
  const deleteVault = async (d1: ReturnType<typeof fakeD1>, vaultId: string) => {
    await prepareGrantsForVaultDelete(d1, vaultId);
    d1.db.prepare(`DELETE FROM vault WHERE id = ?`).run(vaultId);
  };

  it("a grant over two ticked vaults covers both, by name, with each current role", async () => {
    const d1 = multiSetup();
    const { tokens } = await connect(d1, new Date(), pick("v2", "v1"));
    const access = await resolveAccessToken(d1, tokens.access_token, new Date());
    expect(access).toMatchObject({ ok: true, vaultScope: "selected" });
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner", "v2:viewer"]);
    const grant = d1.db.prepare(`SELECT vault_id, vault_scope FROM oauth_grant`).get();
    expect(grant).toEqual({ vault_id: "v2", vault_scope: "selected" });
  });

  it("one ticked vault is a single grant: the unchanged Wave OA surface", async () => {
    const d1 = multiSetup();
    const { tokens } = await connect(d1, new Date(), pick("v3"));
    expect(await resolveAccessToken(d1, tokens.access_token, new Date())).toMatchObject({
      ok: true,
      vaultScope: "single",
    });
    expect(await ids(d1, tokens.access_token)).toEqual(["v3:owner"]);
  });

  it("removing the member drops that vault, and re-adding them does not restore it", async () => {
    const d1 = multiSetup();
    const { tokens } = await connect(d1, new Date(), pick("v1", "v2"));
    await removeMember(d1, "v2", "u1");
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner"]);
    addMember(d1, "v2", "u1", "editor");
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner"]);
  });

  it("losing every covered vault kills the token and the refresh revokes the grant", async () => {
    const d1 = multiSetup();
    const { client, tokens } = await connect(d1, new Date(), pick("v1", "v2"));
    // Membership is checked on every call even before the join rows go.
    d1.db.prepare(`DELETE FROM vault_member WHERE user_id = 'u1'`).run();
    expect(await ids(d1, tokens.access_token)).toBe("invalid");
    const res = await handleTokenRequest(
      { db: d1, now: new Date(), fetchImpl: noFetch },
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id },
      null,
    );
    expect(res.body).toMatchObject({ error: "invalid_grant" });
    expect(d1.db.prepare(`SELECT revoked_at FROM oauth_grant`).get()).not.toEqual({ revoked_at: null });
  });

  it("an all-vaults grant follows membership, including vaults joined later", async () => {
    const d1 = multiSetup();
    const { tokens } = await connect(d1, new Date(), ALL);
    expect(await resolveAccessToken(d1, tokens.access_token, new Date())).toMatchObject({ vaultScope: "all" });
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner", "v2:viewer", "v3:owner"]);
    await removeMember(d1, "v2", "u1");
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner", "v3:owner"]);
    seedOwner(d1, "u3", "v4");
    addMember(d1, "v4", "u1", "editor");
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner", "v3:owner", "v4:editor"]);
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM oauth_grant_vault`).get()).toEqual({ n: 0 });
  });

  it("deleting the anchor vault re-anchors a multi-vault grant instead of cascading it", async () => {
    const d1 = multiSetup();
    const selected = await connect(d1, new Date(), pick("v1", "v3"));
    const all = await connect(d1, new Date(), ALL);
    await deleteVault(d1, "v1");
    expect(await ids(d1, selected.tokens.access_token)).toEqual(["v3:owner"]);
    expect(await ids(d1, all.tokens.access_token)).toEqual(["v2:viewer", "v3:owner"]);
  });

  it("deleting a single grant's vault still cascades the grant away", async () => {
    const d1 = multiSetup();
    const { tokens } = await connect(d1, new Date(), pick("v3"));
    await deleteVault(d1, "v3");
    expect(await ids(d1, tokens.access_token)).toBe("invalid");
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM oauth_grant`).get()).toEqual({ n: 0 });
  });

  it("the exchange keeps only vaults the user still belongs to, and refuses an empty set", async () => {
    const d1 = multiSetup();
    const now = new Date();
    const client = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, now);
    const v = await validateAuthorizeRequest(d1, await authorizeParams(client.client_id), ISSUER, noFetch);
    if (!v.ok) throw new Error("authorize failed");
    const exchange = async (vaults: ReturnType<typeof pick>) => {
      const code = await createAuthorizationCode(d1, { request: v.request, userId: "u1", ...vaults, now });
      return handleTokenRequest(
        { db: d1, now, fetchImpl: noFetch },
        { grant_type: "authorization_code", code, code_verifier: VERIFIER, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id },
        null,
      );
    };
    const twoCode = await createAuthorizationCode(d1, { request: v.request, userId: "u1", ...pick("v2", "v3"), now });
    d1.db.prepare(`DELETE FROM vault_member WHERE vault_id = 'v2' AND user_id = 'u1'`).run();
    const ok = await handleTokenRequest(
      { db: d1, now, fetchImpl: noFetch },
      { grant_type: "authorization_code", code: twoCode, code_verifier: VERIFIER, redirect_uri: CLAUDE_CALLBACK, client_id: client.client_id },
      null,
    );
    expect(await ids(d1, (ok.body as OAuthTokenResponse).access_token)).toEqual(["v3:owner"]);
    // The anchor moved to the surviving vault.
    expect(d1.db.prepare(`SELECT vault_id FROM oauth_grant`).get()).toEqual({ vault_id: "v3" });
    expect((await exchange(pick("v2"))).body).toMatchObject({ error: "invalid_grant" });
  });

  it("drops vaults of an expired provisional owner; all expired reads as owner_expired", async () => {
    const d1 = multiSetup();
    const { tokens } = await connect(d1, new Date(), pick("v1", "v2"));
    const past = Date.now() - 1000;
    d1.db.prepare(`UPDATE user SET expires_at = ? WHERE id = 'u2'`).run(past);
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner"]);
    d1.db.prepare(`UPDATE user SET expires_at = ? WHERE id = 'u1'`).run(past);
    expect(await ids(d1, tokens.access_token)).toBe("owner_expired");
  });
  // ---- review finding 2: deploy window + no resurrection
  it("a single grant with no join row (minted by the pre-multi-vault code) still covers its anchor", async () => {
    const d1 = multiSetup();
    const { client, tokens } = await connect(d1, new Date(), pick("v3"));
    d1.db.prepare(`DELETE FROM oauth_grant_vault`).run(); // as the old code would have left it
    expect(await ids(d1, tokens.access_token)).toEqual(["v3:owner"]);
    const refreshed = await handleTokenRequest(
      { db: d1, now: new Date(), fetchImpl: noFetch },
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id },
      null,
    );
    expect(refreshed.status).toBe(200);
    // The fallback is still intersected with membership.
    d1.db.prepare(`DELETE FROM vault_member WHERE vault_id = 'v3'`).run();
    expect(await ids(d1, (refreshed.body as OAuthTokenResponse).access_token)).toBe("invalid");
    // A selected grant gets no such fallback.
    const sel = await connect(d1, new Date(), pick("v1", "v2"));
    d1.db.prepare(`DELETE FROM oauth_grant_vault`).run();
    expect(await ids(d1, sel.tokens.access_token)).toBe("invalid");
  });

  it("the README re-backfill is idempotent and only fills single grants with no row", async () => {
    const d1 = multiSetup();
    await connect(d1, new Date(), pick("v3"));
    await connect(d1, new Date(), pick("v1", "v2"));
    await connect(d1, new Date(), ALL);
    const singleId = (d1.db.prepare(`SELECT id FROM oauth_grant WHERE vault_scope = 'single'`).get() as { id: string }).id;
    d1.db.prepare(`DELETE FROM oauth_grant_vault WHERE grant_id = ?`).run(singleId);
    const rows = () => d1.db.prepare(`SELECT grant_id, vault_id FROM oauth_grant_vault ORDER BY grant_id, vault_id`).all();
    const before = rows();
    for (let i = 0; i < 2; i++) d1.db.prepare(REBACKFILL_SQL).run();
    const after = rows();
    expect(after).toHaveLength(before.length + 1);
    expect(after).toContainEqual({ grant_id: singleId, vault_id: "v3" });
  });

  it("removing the member revokes a single grant outright, so a re-add can't resurrect it via the fallback", async () => {
    const d1 = multiSetup();
    const { client, tokens } = await connect(d1, new Date(), pick("v3"));
    await removeMember(d1, "v3", "u1");
    addMember(d1, "v3", "u1", "owner");
    expect(await ids(d1, tokens.access_token)).toBe("invalid");
    const refresh = await handleTokenRequest(
      { db: d1, now: new Date(), fetchImpl: noFetch },
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id },
      null,
    );
    expect(refresh.body).toMatchObject({ error: "invalid_grant" });
  });

  // ---- review finding 3: atomic member removal
  it("member removal is one batch: a failure leaves the membership AND the grant rows untouched", async () => {
    const d1 = multiSetup();
    const { tokens } = await connect(d1, new Date(), pick("v1", "v2"));
    const failing = d1.prepare(`INSERT INTO vault (id) VALUES (?)`).bind("no-owner"); // NOT NULL fails at run
    await expect(
      d1.batch([...memberRemovalStatements(d1, { vaultId: "v2", userId: "u1", now: new Date() }), failing]),
    ).rejects.toThrow();
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner", "v2:viewer"]);
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM oauth_grant_vault`).get()).toEqual({ n: 2 });
  });

  it("members.ts deleteMember runs the removal as a single D1 batch", async () => {
    const d1 = multiSetup();
    const { tokens } = await connect(d1, new Date(), pick("v1", "v2"));
    const batches: number[] = [];
    const spy = { ...d1, batch: async (st: readonly { run(): Promise<unknown> }[]) => (batches.push(st.length), d1.batch(st)) };
    await membersDbFrom({} as Db, spy as unknown as D1Database).deleteMember("v2", "u1");
    expect(batches).toEqual([3]);
    expect(await ids(d1, tokens.access_token)).toEqual(["v1:owner"]);
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM vault_member WHERE vault_id = 'v2' AND user_id = 'u1'`).get()).toEqual({ n: 0 });
  });

  // ---- review finding 4: an "all" grant outlives the last vault
  it("an all-vaults grant survives deleting the user's last vault, 401s meanwhile, and recovers", async () => {
    const d1 = setup(); // u1 owns only v1
    const { client, tokens } = await connect(d1, new Date(), ALL);
    await deleteVault(d1, "v1");
    expect(d1.db.prepare(`SELECT vault_id, revoked_at FROM oauth_grant`).get()).toEqual({ vault_id: null, revoked_at: null });
    expect(await ids(d1, tokens.access_token)).toBe("no_vault");
    const refreshed = await handleTokenRequest(
      { db: d1, now: new Date(), fetchImpl: noFetch },
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id },
      null,
    );
    expect(refreshed.status).toBe(200);
    seedOwner(d1, "u5", "v5");
    addMember(d1, "v5", "u1", "editor");
    expect(await ids(d1, (refreshed.body as OAuthTokenResponse).access_token)).toEqual(["v5:editor"]);
  });

  it("single and selected grants left with nothing are still deleted with the vault", async () => {
    const d1 = setup();
    const single = await connect(d1, new Date(), pick("v1"));
    await deleteVault(d1, "v1");
    expect(await ids(d1, single.tokens.access_token)).toBe("invalid");
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM oauth_grant`).get()).toEqual({ n: 0 });
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM oauth_token`).get()).toEqual({ n: 0 });
  });
});

describe("migration 0014 (nullable oauth_grant anchor) preserves live login data", () => {
  const TABLES = ["oauth_grant", "oauth_token", "oauth_grant_vault", "oauth_code"] as const;
  const ORDER: Record<(typeof TABLES)[number], string> = {
    oauth_grant: "id",
    oauth_token: "token_hash",
    oauth_grant_vault: "grant_id, vault_id",
    oauth_code: "code_hash",
  };

  /** A 0001–0013 control plane with real grants, rotated token families, join rows and codes. */
  async function populated0013() {
    const d1 = fakeD1({ through: 13 });
    seedOwner(d1, "u1", "v1");
    addMember(d1, "v1", "u1", "owner");
    seedOwner(d1, "u2", "v2");
    addMember(d1, "v2", "u2", "owner");
    addMember(d1, "v2", "u1", "viewer");
    const now = new Date();
    // Live grants (single + selected + all), each with a rotated refresh family.
    for (const vaults of [SINGLE_V1, { selection: { all: false, vaultIds: ["v1", "v2"] }, anchorVaultId: "v1" }, { selection: { all: true, vaultIds: [] }, anchorVaultId: "v1" }]) {
      const { client, tokens } = await connect(d1, now, vaults);
      await handleTokenRequest(
        { db: d1, now, fetchImpl: noFetch },
        { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id },
        null,
      );
    }
    // A revoked grant, and an unused code still waiting to be exchanged.
    const revoked = await connect(d1, now);
    await handleRevokeRequest({ db: d1, now, fetchImpl: noFetch }, { token: revoked.tokens.access_token, client_id: revoked.client.client_id }, null);
    const v = await validateAuthorizeRequest(d1, await authorizeParams(revoked.client.client_id), ISSUER, noFetch);
    if (!v.ok) throw new Error("authorize failed");
    await createAuthorizationCode(d1, { request: v.request, userId: "u1", ...SINGLE_V1, now });
    return d1;
  }

  const dump = (d1: ReturnType<typeof fakeD1>) =>
    Object.fromEntries(TABLES.map((t) => [t, d1.db.prepare(`SELECT * FROM ${t} ORDER BY ${ORDER[t]}`).all()]));
  const counts = (d1: ReturnType<typeof fakeD1>) =>
    Object.fromEntries(TABLES.map((t) => [t, (d1.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));

  it("keeps every grant, token, join row and code, byte for byte", async () => {
    const d1 = await populated0013();
    const before = { counts: counts(d1), rows: dump(d1) };
    expect(before.counts).toEqual({ oauth_grant: 4, oauth_token: 14, oauth_grant_vault: 4, oauth_code: 5 });
    applyMigration(d1, 14);
    expect(counts(d1)).toEqual(before.counts);
    expect(dump(d1)).toEqual(before.rows);
    expect(d1.db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(d1.db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '\\_\\_%' ESCAPE '\\'`).all()).toEqual([]);
  });

  it("changes only vault_id's nullability and ON DELETE; every other column, FK and index is unchanged", async () => {
    const d1 = await populated0013();
    const shape = () => ({
      columns: d1.db.prepare(`PRAGMA table_info(oauth_grant)`).all() as { name: string; notnull: number }[],
      fks: d1.db.prepare(`PRAGMA foreign_key_list(oauth_grant)`).all() as { table: string; from: string; on_delete: string }[],
      indexes: (d1.db.prepare(`PRAGMA index_list(oauth_grant)`).all() as { name: string; unique: number; origin: string }[])
        .map(({ name, unique, origin }) => ({ name, unique, origin }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      childFks: ["oauth_token", "oauth_grant_vault"].map((t) => d1.db.prepare(`PRAGMA foreign_key_list(${t})`).all()),
    });
    const before = shape();
    applyMigration(d1, 14);
    const after = shape();
    const vaultCol = (cols: { name: string; notnull: number }[]) => cols.find((c) => c.name === "vault_id");
    expect(vaultCol(before.columns)?.notnull).toBe(1);
    expect(vaultCol(after.columns)?.notnull).toBe(0);
    const others = (cols: { name: string }[]) => cols.filter((c) => c.name !== "vault_id");
    expect(others(after.columns)).toEqual(others(before.columns));
    const fk = (fks: { table: string; from: string; on_delete: string }[], from: string) =>
      fks.filter((f) => f.from === from).map(({ table, on_delete }) => ({ table, on_delete }));
    expect(fk(before.fks, "vault_id")).toEqual([{ table: "vault", on_delete: "CASCADE" }]);
    expect(fk(after.fks, "vault_id")).toEqual([{ table: "vault", on_delete: "SET NULL" }]);
    expect(fk(after.fks, "user_id")).toEqual(fk(before.fks, "user_id"));
    expect(after.indexes).toEqual(before.indexes);
    expect(after.childFks).toEqual(before.childFks);
    // The children still cascade from the rebuilt table.
    d1.db.prepare(`DELETE FROM oauth_grant`).run();
    expect(counts(d1)).toMatchObject({ oauth_token: 0, oauth_grant_vault: 0 });
  });

  it("is atomic: a failure mid-migration leaves the 0013 schema and data untouched", async () => {
    const d1 = await populated0013();
    const before = { counts: counts(d1), rows: dump(d1) };
    d1.db.exec(`CREATE TABLE __bk_oauth_grant_vault (x)`); // makes the second statement fail
    expect(() => applyMigration(d1, 14)).toThrow();
    d1.db.exec(`DROP TABLE __bk_oauth_grant_vault`);
    expect(counts(d1)).toEqual(before.counts);
    expect(dump(d1)).toEqual(before.rows);
    expect((d1.db.prepare(`PRAGMA table_info(oauth_grant)`).all() as { name: string; notnull: number }[]).find((c) => c.name === "vault_id")?.notnull).toBe(1);
  });
});
