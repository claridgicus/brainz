import { describe, expect, it } from "vitest";
import {
  oauthAuthorizationServerMetadataSchema,
  oauthClientRegistrationResponseSchema,
  oauthErrorSchema,
  oauthProtectedResourceMetadataSchema,
  oauthTokenResponseSchema,
  type OAuthTokenResponse,
} from "@brainz/contracts";
import { fakeD1, seedOwner } from "./fake-d1.testutil";
import {
  authorizationServerMetadata,
  callsGatedTool,
  createAuthorizationCode,
  fetchClientMetadataDocument,
  handleRevokeRequest,
  handleTokenRequest,
  isCrossSiteFormPost,
  protectedResourceMetadata,
  readOAuthForm,
  redirectUriMatches,
  redirectUriProblem,
  registerClient,
  resolveAccessToken,
  s256,
  validateAuthorizeRequest,
  wwwAuthenticate,
  type FetchLike,
} from "./oauth";

const ISSUER = "https://brainz.example";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-._~" + "A1".repeat(10);
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
async function connect(d1: ReturnType<typeof fakeD1>, now = new Date()) {
  const client = await registerClient(
    d1,
    { redirect_uris: [CLAUDE_CALLBACK, "http://localhost/callback"], token_endpoint_auth_method: "none", client_name: "Claude" },
    now,
  );
  const v = await validateAuthorizeRequest(d1, await authorizeParams(client.client_id), ISSUER, noFetch);
  if (!v.ok) throw new Error("authorize failed");
  const code = await createAuthorizationCode(d1, { request: v.request, userId: "u1", vaultId: "v1", now });
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

  it("the 401 challenge points at the path-suffixed metadata", () => {
    const h = wwwAuthenticate(ISSUER, 'needs "auth"');
    expect(h).toMatch(/^Bearer error="invalid_token"/);
    expect(h).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`);
    expect(h).toContain('scope="vault"');
    expect(h).not.toContain('"auth"');
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
  const serving = (body: string, status = 200): FetchLike => async () => new Response(body, { status });

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

  it("defaults the redirect when exactly one is registered", async () => {
    const d1 = fakeD1();
    const client = await registerClient(d1, { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }, new Date());
    const params = await authorizeParams(client.client_id);
    params.delete("redirect_uri");
    const v = await validateAuthorizeRequest(d1, params, ISSUER, noFetch);
    expect(v.ok && v.request.redirectUri).toBe(CLAUDE_CALLBACK);
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
    expect(access).toMatchObject({ ok: true, userId: "u1", vaultId: "v1", role: "owner", ownerId: "u1" });
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
    const freshCode = () => createAuthorizationCode(d1, { request: v.request, userId: "u1", vaultId: "v1", now });
    const deps = { db: d1, now, fetchImpl: noFetch };
    const base = { grant_type: "authorization_code", client_id: client.client_id, code_verifier: VERIFIER };

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
    for (const r of [wrongVerifier, wrongRedirect, otherClient, late, noPkce]) {
      expect(oauthErrorSchema.safeParse(r.body).success).toBe(true);
    }
  });

  it("rotates refresh tokens and treats reuse as theft", async () => {
    const d1 = setup();
    const { client, tokens } = await connect(d1);
    const deps = { db: d1, now: new Date(), fetchImpl: noFetch };
    const refresh = (token: string, clientId = client.client_id) =>
      handleTokenRequest(deps, { grant_type: "refresh_token", refresh_token: token, client_id: clientId }, null);

    const second = await refresh(tokens.refresh_token);
    expect(second.status).toBe(200);
    const pair = second.body as OAuthTokenResponse;
    expect(pair.refresh_token).not.toBe(tokens.refresh_token);
    expect((await resolveAccessToken(d1, pair.access_token, new Date())).ok).toBe(true);

    const reuse = await refresh(tokens.refresh_token);
    expect(reuse.body).toMatchObject({ error: "invalid_grant" });
    // The whole grant is dead, including the pair issued by the rotation.
    expect((await resolveAccessToken(d1, pair.access_token, new Date())).ok).toBe(false);
    expect((await refresh(pair.refresh_token)).body).toMatchObject({ error: "invalid_grant" });
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
    const code = await createAuthorizationCode(d1, { request: v.request, userId: "u1", vaultId: "v1", now });
    const form = { grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: client.client_id };

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
    const code2 = await createAuthorizationCode(d1, { request: v.request, userId: "u1", vaultId: "v1", now });
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
    expect(await resolveAccessToken(d1, tokens.access_token, new Date())).toMatchObject({ ok: true, role: "viewer" });
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
