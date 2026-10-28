/**
 * OAuth 2.1 authorization server for the remote MCP endpoint (Wave OA,
 * SPEC-CLOUD.md "OAuth 2.1 for remote MCP").
 *
 * Why hand-rolled: Better Auth's `mcp` / `oidcProvider` plugin (deprecated
 * upstream) stores tokens in plaintext, never invalidates a rotated refresh
 * token, issues refresh tokens only for `offline_access`, has no client ID
 * metadata documents and no way to bind a grant to a vault. Better Auth stays
 * the identity layer — the consent page reads its session.
 *
 * Pieces:
 * - discovery documents (RFC 9728 protected resource, RFC 8414 AS metadata)
 * - client registration: DCR (RFC 7591, `oauth_client`) and client ID metadata
 *   documents (an https client_id fetched at authorize time, public client)
 * - authorize-request validation + code minting (the consent page drives it)
 * - the token endpoint (authorization_code + PKCE S256, rotating refresh
 *   tokens with reuse detection) and revocation (RFC 7009)
 * - access-token resolution for /mcp
 *
 * Every code and token is SHA-256 hashed at rest. All persistence goes through
 * the small `D1Like` port so this module is unit-tested on the migrated schema
 * (fake-d1.testutil) without a Workers runtime.
 */
import {
  OAUTH_VAULT_SCOPE,
  oauthClientRegistrationRequestSchema,
  type OAuthAuthorizationServerMetadata,
  type OAuthClientRegistrationResponse,
  type OAuthErrorCode,
  type OAuthProtectedResourceMetadata,
  type OAuthTokenEndpointAuthMethod,
  type OAuthTokenResponse,
  type VaultRole,
} from "@brainz/contracts";
import { hashApiKey as sha256Hex } from "./api-keys";
import { isOwnerExpired } from "./vault-access";

// ------------------------------------------------------------------ ports

/** The D1 surface this module needs (real D1 in prod, better-sqlite3 in tests). */
export interface OAuthDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// -------------------------------------------------------------- constants

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** Sliding: every rotation issues a fresh 30-day refresh token. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
/**
 * A refresh token rotated less than this long ago may be presented again by
 * the same client (concurrent refreshes, a retry after a timed-out response)
 * without counting as theft: it gets a fresh pair instead of revoking the grant.
 */
export const REFRESH_REUSE_GRACE_SECONDS = 60;

export const ACCESS_TOKEN_PREFIX = "bzat_";
export const REFRESH_TOKEN_PREFIX = "bzrt_";
const CLIENT_ID_PREFIX = "bzc_";
const CLIENT_SECRET_PREFIX = "bzcs_";

/** Paths the AS serves (relative to the issuer). */
export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
  revoke: "/oauth/revoke",
  protectedResource: "/.well-known/oauth-protected-resource",
  authorizationServer: "/.well-known/oauth-authorization-server",
} as const;

/**
 * Endpoints hit server-to-server with form-encoded bodies and no matching
 * Origin. They authenticate the client themselves and never read cookies, so
 * hooks.server.ts exempts them from the cross-site form-POST check.
 */
export const CSRF_EXEMPT_PATHS: ReadonlySet<string> = new Set([OAUTH_PATHS.token, OAUTH_PATHS.revoke]);

/** DCR: registrations per client IP per rolling hour (Anthropic's egress range is exempt). */
export const REGISTER_RATE_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
/** DCR clients that never obtained a grant are purged after this long. */
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

const CIMD_TIMEOUT_MS = 5_000;
const CIMD_MAX_BYTES = 16 * 1024;

// ----------------------------------------------------------------- errors

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status = code === "invalid_client" ? 401 : 400,
  ) {
    super(description);
  }

  body(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}

// -------------------------------------------------------------- discovery

/** The issuer: the pinned production URL, else the request origin (dev). */
export function issuerFor(betterAuthUrl: string | undefined, requestOrigin: string): string {
  return (betterAuthUrl || requestOrigin).replace(/\/+$/, "");
}

/** The protected resource: the MCP endpoint, exactly as users add it. */
export function resourceUrl(issuer: string): string {
  return `${issuer}/mcp`;
}

/** Path-suffixed RFC 9728 location — what the 401 challenge points at. */
export function protectedResourceMetadataUrl(issuer: string): string {
  return `${issuer}${OAUTH_PATHS.protectedResource}/mcp`;
}

export function protectedResourceMetadata(issuer: string): OAuthProtectedResourceMetadata {
  return {
    resource: resourceUrl(issuer),
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_VAULT_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Brainz",
    resource_documentation: "https://brownmatter.ai/docs",
  };
}

export function authorizationServerMetadata(issuer: string): OAuthAuthorizationServerMetadata {
  const authMethods: OAuthTokenEndpointAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];
  return {
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${issuer}${OAUTH_PATHS.token}`,
    registration_endpoint: `${issuer}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${issuer}${OAUTH_PATHS.revoke}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: authMethods,
    revocation_endpoint_auth_methods_supported: authMethods,
    scopes_supported: [OAUTH_VAULT_SCOPE, "offline_access"],
    client_id_metadata_document_supported: true,
    service_documentation: "https://brownmatter.ai/docs",
  };
}

/**
 * The RFC 6750 challenge every /mcp 401 carries. `resource_metadata` is what
 * makes Claude / ChatGPT start (or refresh) the OAuth flow. Per RFC 6750 §3.1
 * the `error` code is sent only when a token WAS presented and rejected
 * (`invalidToken`); a request with no credentials gets the bare challenge.
 */
export function wwwAuthenticate(issuer: string, opts: { invalidToken?: string } = {}): string {
  const params = [
    ...(opts.invalidToken !== undefined
      ? [`error="invalid_token"`, `error_description="${opts.invalidToken.replace(/["\\]/g, "")}"`]
      : []),
    `resource_metadata="${protectedResourceMetadataUrl(issuer)}"`,
    `scope="${OAUTH_VAULT_SCOPE}"`,
  ];
  return `Bearer ${params.join(", ")}`;
}

// ------------------------------------------------------------ randomness

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** `prefix` + `length` unbiased base62 chars (rejection sampling). */
export function randomToken(prefix: string, length = 40): string {
  let out = prefix;
  while (out.length < prefix.length + length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length))) {
      // 248 = 4 × 62: reject the tail so every char is equally likely.
      if (b < 248 && out.length < prefix.length + length) out += BASE62[b % 62];
    }
  }
  return out;
}

/** BASE64URL(SHA-256(verifier)) — the RFC 7636 S256 transform. */
export async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 §4.1: 43–128 unreserved chars. */
export function isValidCodeVerifier(v: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

/** A well-formed S256 challenge is 43 base64url chars. */
function isValidCodeChallenge(c: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(c);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --------------------------------------------------------- redirect URIs

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isLoopbackHttp(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * Registration rule for one redirect URI: https with no fragment, or http on
 * a loopback host (native clients such as Claude Code). Returns an error
 * message, or null when acceptable.
 */
export function redirectUriProblem(raw: string): string | null {
  const u = parseUrl(raw);
  if (!u) return `not an absolute URL: ${raw}`;
  if (u.hash) return `redirect URIs must not carry a fragment: ${raw}`;
  if (u.username || u.password) return `redirect URIs must not carry credentials: ${raw}`;
  if (u.protocol === "https:") return null;
  if (isLoopbackHttp(u)) return null;
  return `redirect URIs must be https, or http on localhost / 127.0.0.1 / [::1]: ${raw}`;
}

/**
 * Does `requested` match one of the registered URIs? Exact string equality,
 * except loopback http URIs, which match with the port ignored (RFC 8252
 * §7.3; applied to `localhost` too because Claude Code declares it).
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  const req = parseUrl(requested);
  if (!req || !isLoopbackHttp(req) || req.hash) return false;
  return registered.some((r) => {
    const reg = parseUrl(r);
    return (
      reg !== null &&
      isLoopbackHttp(reg) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search
    );
  });
}

/** Append OAuth response params to a redirect URI (keeps its own query). */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

// ------------------------------------------------------------- clients

/**
 * Anthropic's published egress range (160.79.104.0/21): Claude registers a
 * fresh DCR client on every new connection from these few addresses, so they
 * are exempt from the per-IP registration limit.
 */
export function isAnthropicEgress(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a === 160 && b === 79 && c >= 104 && c <= 111;
}

/**
 * Durable per-IP limit on DCR (record-then-count, like signup_events): true
 * when this registration should be refused.
 */
export async function registrationThrottled(db: OAuthDb, ip: string, now: Date): Promise<boolean> {
  if (isAnthropicEgress(ip)) return false;
  await db
    .prepare(`INSERT INTO oauth_register_events (id, ip, created_at) VALUES (?, ?, ?)`)
    .bind(crypto.randomUUID(), ip, now.getTime())
    .run();
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM oauth_register_events WHERE ip = ? AND created_at > ?`)
    .bind(ip, now.getTime() - REGISTER_WINDOW_MS)
    .first<{ n: number }>();
  return (row?.n ?? 0) > REGISTER_RATE_LIMIT;
}

/**
 * Housekeeping run alongside registration: drop DCR clients older than
 * UNUSED_CLIENT_TTL_MS that never obtained a grant (and have no pending code),
 * plus registration events past the rate window.
 */
export async function purgeUnusedClients(db: OAuthDb, now: Date): Promise<void> {
  await db
    .prepare(
      `DELETE FROM oauth_client WHERE created_at < ?
         AND NOT EXISTS (SELECT 1 FROM oauth_grant g WHERE g.client_id = oauth_client.client_id)
         AND NOT EXISTS (SELECT 1 FROM oauth_code c WHERE c.client_id = oauth_client.client_id AND c.expires_at > ?)`,
    )
    .bind(now.getTime() - UNUSED_CLIENT_TTL_MS, now.getTime())
    .run();
  await db
    .prepare(`DELETE FROM oauth_register_events WHERE created_at < ?`)
    .bind(now.getTime() - REGISTER_WINDOW_MS)
    .run();
}

export interface ResolvedClient {
  clientId: string;
  kind: "dcr" | "cimd";
  /** What the consent screen names: client_name for DCR, the URL host for CIMD. */
  displayName: string;
  /** True when the display name is the client's own claim (DCR client_name). */
  selfAsserted: boolean;
  redirectUris: string[];
  authMethod: OAuthTokenEndpointAuthMethod;
  secretHash: string | null;
}

/** RFC 7591 registration. Throws OAuthError (invalid_client_metadata / invalid_redirect_uri). */
export async function registerClient(
  db: OAuthDb,
  body: unknown,
  now: Date,
): Promise<OAuthClientRegistrationResponse> {
  const parsed = oauthClientRegistrationRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new OAuthError(
      "invalid_client_metadata",
      parsed.error.issues[0]?.message ?? "malformed registration request",
    );
  }
  const req = parsed.data;
  for (const uri of req.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthError("invalid_redirect_uri", problem);
  }
  const grantTypes = req.grant_types ?? ["authorization_code"];
  const badGrant = grantTypes.find((g) => g !== "authorization_code" && g !== "refresh_token");
  if (badGrant) throw new OAuthError("invalid_client_metadata", `unsupported grant type: ${badGrant}`);
  const responseTypes = req.response_types ?? ["code"];
  if (responseTypes.some((r) => r !== "code")) {
    throw new OAuthError("invalid_client_metadata", "only the `code` response type is supported");
  }
  // RFC 7591 §2: the default is client_secret_basic.
  const authMethod = req.token_endpoint_auth_method ?? "client_secret_basic";
  const clientId = randomToken(CLIENT_ID_PREFIX, 24);
  const clientSecret = authMethod === "none" ? undefined : randomToken(CLIENT_SECRET_PREFIX, 40);

  await db
    .prepare(
      `INSERT INTO oauth_client (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      clientId,
      clientSecret ? await sha256Hex(clientSecret) : null,
      req.client_name ?? null,
      JSON.stringify(req.redirect_uris),
      authMethod,
      now.getTime(),
    )
    .run();

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    redirect_uris: req.redirect_uris,
    token_endpoint_auth_method: authMethod,
    grant_types: grantTypes.includes("refresh_token") ? grantTypes : [...grantTypes, "refresh_token"],
    response_types: ["code"],
    ...(req.client_name ? { client_name: req.client_name } : {}),
  };
}

/** Is this client_id a client ID metadata document URL (https with a path)? */
export function isCimdClientId(clientId: string): boolean {
  const u = parseUrl(clientId);
  return u !== null && u.protocol === "https:" && u.pathname !== "/" && !u.hash;
}

function isForbiddenFetchHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
    hostname.startsWith("[")
  );
}

/**
 * Fetch + validate a client ID metadata document. https only, no IP-literal
 * or localhost hosts, no redirects, 5 s timeout, 16 KB cap; the document's
 * own `client_id` must equal the URL. Returns null on any failure.
 */
export async function fetchClientMetadataDocument(
  clientId: string,
  fetchImpl: FetchLike,
): Promise<ResolvedClient | null> {
  if (!isCimdClientId(clientId)) return null;
  const url = new URL(clientId);
  if (isForbiddenFetchHost(url.hostname)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CIMD_TIMEOUT_MS);
  try {
    const res = await fetchImpl(clientId, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status !== 200) return null;
    if (!/^application\/([\w.+-]*\+)?json\b/i.test(res.headers.get("content-type") ?? "")) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > CIMD_MAX_BYTES) return null;
    const text = await readCapped(res, CIMD_MAX_BYTES);
    if (text === null) return null;
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc.client_id !== clientId) return null;
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
      return null;
    }
    if (uris.some((u) => redirectUriProblem(u as string) !== null)) return null;
    // Only public CIMD clients are supported (that is what Claude registers as).
    const method = doc.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") return null;
    return {
      clientId,
      kind: "cimd",
      displayName: url.host,
      selfAsserted: false,
      redirectUris: uris as string[],
      authMethod: "none",
      secretHash: null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body with a running byte count, cancelling the stream as
 * soon as it passes `maxBytes` (content-length can be absent or lie, and a
 * buffered `res.text()` would let a hostile URL exhaust isolate memory).
 */
export async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** Look a client up: a DCR row, else a CIMD URL (fetched). Null when unknown. */
export async function resolveClient(
  db: OAuthDb,
  clientId: string,
  fetchImpl: FetchLike,
): Promise<ResolvedClient | null> {
  if (!clientId) return null;
  if (clientId.startsWith(CLIENT_ID_PREFIX)) {
    const row = await db
      .prepare(
        `SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method
         FROM oauth_client WHERE client_id = ?`,
      )
      .bind(clientId)
      .first<{
        client_id: string;
        client_secret_hash: string | null;
        client_name: string | null;
        redirect_uris: string;
        token_endpoint_auth_method: OAuthTokenEndpointAuthMethod;
      }>();
    if (!row) return null;
    return {
      clientId: row.client_id,
      kind: "dcr",
      displayName: row.client_name || "An unnamed application",
      selfAsserted: true,
      redirectUris: JSON.parse(row.redirect_uris) as string[],
      authMethod: row.token_endpoint_auth_method,
      secretHash: row.client_secret_hash,
    };
  }
  return fetchClientMetadataDocument(clientId, fetchImpl);
}

// ------------------------------------------------------------ authorize

export interface AuthorizeRequest {
  client: ResolvedClient;
  redirectUri: string;
  /** Did the request carry redirect_uri? Then the token request must repeat it (RFC 6749 §4.1.3). */
  redirectUriExplicit: boolean;
  codeChallenge: string;
  state: string | undefined;
  scope: string;
}

export type AuthorizeValidation =
  | { ok: true; request: AuthorizeRequest }
  /** Untrusted client or redirect: show an error page, NEVER redirect. */
  | { ok: false; fatal: true; message: string }
  /** Trusted redirect: bounce the error back to the client. */
  | { ok: false; fatal: false; redirectTo: string };

/** Validate an authorization request (RFC 6749 §4.1.1 + OAuth 2.1 PKCE + RFC 8707). */
export async function validateAuthorizeRequest(
  db: OAuthDb,
  params: URLSearchParams,
  issuer: string,
  fetchImpl: FetchLike,
): Promise<AuthorizeValidation> {
  const clientId = params.get("client_id") ?? "";
  const client = await resolveClient(db, clientId, fetchImpl);
  if (!client) {
    return { ok: false, fatal: true, message: "Unknown or unreachable OAuth client." };
  }
  const requested = params.get("redirect_uri");
  let redirectUri: string;
  if (requested) {
    if (!redirectUriMatches(client.redirectUris, requested)) {
      return { ok: false, fatal: true, message: "That redirect URI is not registered for this client." };
    }
    redirectUri = requested;
  } else if (client.redirectUris.length === 1) {
    redirectUri = client.redirectUris[0];
  } else {
    return { ok: false, fatal: true, message: "redirect_uri is required." };
  }

  const state = params.get("state") ?? undefined;
  const bounce = (error: OAuthErrorCode, description: string): AuthorizeValidation => ({
    ok: false,
    fatal: false,
    redirectTo: buildRedirect(redirectUri, { error, error_description: description, state, iss: issuer }),
  });

  if (params.get("response_type") !== "code") {
    return bounce("unsupported_response_type", "response_type must be `code`");
  }
  const challenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !isValidCodeChallenge(challenge)) {
    return bounce("invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256");
  }
  const resource = params.get("resource");
  if (resource !== null) {
    const expected = resourceUrl(issuer);
    if (resource !== expected && resource !== `${expected}/`) {
      return bounce("invalid_target", `the only resource served here is ${expected}`);
    }
  }
  return {
    ok: true,
    request: {
      client,
      redirectUri,
      redirectUriExplicit: requested !== null && requested !== "",
      codeChallenge: challenge,
      state,
      scope: OAUTH_VAULT_SCOPE,
    },
  };
}

/** Mint a single-use authorization code bound to client, redirect, PKCE, user, vault. */
export async function createAuthorizationCode(
  db: OAuthDb,
  args: { request: AuthorizeRequest; userId: string; vaultId: string; now: Date },
): Promise<string> {
  const code = randomToken("", 43);
  const { request, now } = args;
  await db
    .prepare(
      `INSERT INTO oauth_code (code_hash, client_id, user_id, vault_id, redirect_uri, redirect_uri_explicit, code_challenge, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(code),
      request.client.clientId,
      args.userId,
      args.vaultId,
      request.redirectUri,
      request.redirectUriExplicit ? 1 : 0,
      request.codeChallenge,
      request.scope,
      now.getTime(),
      now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000,
    )
    .run();
  return code;
}

// ---------------------------------------------------------------- token

export interface TokenDeps {
  db: OAuthDb;
  now: Date;
  fetchImpl: FetchLike;
  /** Override REFRESH_REUSE_GRACE_SECONDS (env OAUTH_REFRESH_GRACE_SECONDS; the E2E shortens it). */
  refreshGraceSeconds?: number;
}

/** Parse the OAUTH_REFRESH_GRACE_SECONDS override; falls back to the default. */
export function refreshGraceFromEnv(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : REFRESH_REUSE_GRACE_SECONDS;
}

export interface TokenHttpResult {
  status: number;
  body: OAuthTokenResponse | { error: OAuthErrorCode; error_description: string } | Record<string, never>;
  headers: Record<string, string>;
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

/** Read a token/revoke request body: form-encoded (RFC 6749) or JSON (tolerated). */
export async function readOAuthForm(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/json")) {
    const json = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    for (const [k, v] of Object.entries(json ?? {})) if (typeof v === "string") out[k] = v;
    return out;
  }
  const params = new URLSearchParams(await request.text());
  for (const [k, v] of params) out[k] = v;
  return out;
}

/**
 * Authenticate the client at the token / revocation endpoint. Confidential
 * clients present a secret (HTTP Basic or client_secret_post); public ones
 * (DCR `none`, CIMD) present only client_id.
 */
export async function authenticateClient(
  db: OAuthDb,
  form: Record<string, string>,
  authorization: string | null,
  fetchImpl: FetchLike,
): Promise<ResolvedClient> {
  let clientId = form.client_id;
  let secret = form.client_secret;
  if (authorization?.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = atob(authorization.slice(6).trim());
    } catch {
      throw new OAuthError("invalid_client", "malformed Basic authorization header");
    }
    const colon = decoded.indexOf(":");
    if (colon < 0) throw new OAuthError("invalid_client", "malformed Basic authorization header");
    let basicId: string;
    try {
      basicId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    } catch {
      throw new OAuthError("invalid_client", "malformed Basic authorization header");
    }
    if (clientId && clientId !== basicId) {
      throw new OAuthError("invalid_client", "client_id does not match the Authorization header");
    }
    clientId = basicId;
  }
  if (!clientId) throw new OAuthError("invalid_client", "client_id is required");
  // CIMD clients are public: the token endpoint needs no fetch for them, the
  // code / refresh token is already bound to the client_id URL.
  const client = isCimdClientId(clientId)
    ? ({
        clientId,
        kind: "cimd",
        displayName: new URL(clientId).host,
        selfAsserted: false,
        redirectUris: [],
        authMethod: "none",
        secretHash: null,
      } satisfies ResolvedClient)
    : await resolveClient(db, clientId, fetchImpl);
  if (!client) throw new OAuthError("invalid_client", "unknown client");
  if (client.authMethod !== "none") {
    if (!secret || !client.secretHash) {
      throw new OAuthError("invalid_client", "client authentication is required");
    }
    if (!constantTimeEqual(await sha256Hex(secret), client.secretHash)) {
      throw new OAuthError("invalid_client", "invalid client credentials");
    }
  }
  return client;
}

async function memberRoleOf(db: OAuthDb, vaultId: string, userId: string): Promise<VaultRole | null> {
  const row = await db
    .prepare(`SELECT role FROM vault_member WHERE vault_id = ? AND user_id = ?`)
    .bind(vaultId, userId)
    .first<{ role: VaultRole }>();
  return row?.role ?? null;
}

async function revokeGrant(db: OAuthDb, grantId: string, now: Date): Promise<void> {
  await db
    .prepare(`UPDATE oauth_grant SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now.getTime(), grantId)
    .run();
}

async function issueTokenPair(db: OAuthDb, grantId: string, scope: string, now: Date): Promise<OAuthTokenResponse> {
  const access = randomToken(ACCESS_TOKEN_PREFIX);
  const refresh = randomToken(REFRESH_TOKEN_PREFIX);
  const insert = `INSERT INTO oauth_token (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`;
  await db
    .prepare(insert)
    .bind(await sha256Hex(access), grantId, "access", now.getTime(), now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000)
    .run();
  await db
    .prepare(insert)
    .bind(await sha256Hex(refresh), grantId, "refresh", now.getTime(), now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000)
    .run();
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope,
  };
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  vault_id: string;
  redirect_uri: string;
  redirect_uri_explicit: number;
  code_challenge: string;
  scope: string;
  expires_at: number;
  used_at: number | null;
  grant_id: string | null;
}

async function exchangeCode(deps: TokenDeps, client: ResolvedClient, form: Record<string, string>) {
  const { db, now } = deps;
  if (!form.code) throw new OAuthError("invalid_request", "code is required");
  const verifier = form.code_verifier ?? "";
  if (!isValidCodeVerifier(verifier)) {
    throw new OAuthError("invalid_request", "a valid code_verifier is required (PKCE)");
  }
  const codeHash = await sha256Hex(form.code);
  // Consume atomically: only the first exchange sees used_at IS NULL.
  const row = await db
    .prepare(`UPDATE oauth_code SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING *`)
    .bind(now.getTime(), codeHash)
    .first<CodeRow>();
  if (!row) {
    const replayed = await db
      .prepare(`SELECT grant_id FROM oauth_code WHERE code_hash = ?`)
      .bind(codeHash)
      .first<{ grant_id: string | null }>();
    // OAuth 2.1 §4.1.3: a replayed code revokes the tokens it produced.
    if (replayed?.grant_id) await revokeGrant(db, replayed.grant_id, now);
    throw new OAuthError("invalid_grant", "authorization code is invalid or already used");
  }
  if (row.expires_at < now.getTime()) throw new OAuthError("invalid_grant", "authorization code expired");
  if (row.client_id !== client.clientId) {
    throw new OAuthError("invalid_grant", "authorization code was issued to another client");
  }
  // RFC 6749 §4.1.3: if the authorization request carried redirect_uri, the
  // token request must repeat it exactly; if it didn't, a supplied value must
  // still be the one the code was issued for.
  if (row.redirect_uri_explicit && form.redirect_uri === undefined) {
    throw new OAuthError("invalid_request", "redirect_uri is required: the authorization request included one");
  }
  if (form.redirect_uri !== undefined && form.redirect_uri !== row.redirect_uri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
  }
  if ((await s256(verifier)) !== row.code_challenge) {
    throw new OAuthError("invalid_grant", "PKCE verification failed");
  }
  if (!(await memberRoleOf(db, row.vault_id, row.user_id))) {
    throw new OAuthError("invalid_grant", "you no longer have access to that vault");
  }
  const grantId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO oauth_grant (id, client_id, user_id, vault_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(grantId, client.clientId, row.user_id, row.vault_id, row.scope, now.getTime())
    .run();
  await db.prepare(`UPDATE oauth_code SET grant_id = ? WHERE code_hash = ?`).bind(grantId, codeHash).run();
  return issueTokenPair(db, grantId, row.scope, now);
}

async function rotateRefresh(deps: TokenDeps, client: ResolvedClient, form: Record<string, string>) {
  const { db, now } = deps;
  if (!form.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
  const tokenHash = await sha256Hex(form.refresh_token);
  const row = await db
    .prepare(
      `SELECT t.expires_at, t.used_at, g.id AS grant_id, g.client_id, g.user_id, g.vault_id, g.scope, g.revoked_at
       FROM oauth_token t JOIN oauth_grant g ON g.id = t.grant_id
       WHERE t.token_hash = ? AND t.kind = 'refresh'`,
    )
    .bind(tokenHash)
    .first<{
      expires_at: number;
      used_at: number | null;
      grant_id: string;
      client_id: string;
      user_id: string;
      vault_id: string;
      scope: string;
      revoked_at: number | null;
    }>();
  // Check the client BEFORE touching anything, so a token presented by the
  // wrong client cannot burn the legitimate client's grant.
  if (!row || row.client_id !== client.clientId) {
    throw new OAuthError("invalid_grant", "refresh token is invalid");
  }
  if (row.revoked_at !== null) throw new OAuthError("invalid_grant", "the grant was revoked");
  if (row.expires_at < now.getTime()) throw new OAuthError("invalid_grant", "refresh token expired");
  if (!(await memberRoleOf(db, row.vault_id, row.user_id))) {
    await revokeGrant(db, row.grant_id, now);
    throw new OAuthError("invalid_grant", "you no longer have access to that vault");
  }
  if (row.used_at !== null) {
    // Same client, rotated moments ago: a concurrent refresh or a retry after
    // a lost response, not theft. Answer with a fresh pair (only hashes are
    // stored, so the earlier pair can't be replayed back verbatim).
    const grace = deps.refreshGraceSeconds ?? REFRESH_REUSE_GRACE_SECONDS;
    if (now.getTime() - row.used_at <= grace * 1000) {
      return issueTokenPair(db, row.grant_id, row.scope, now);
    }
    // Reuse of a rotated refresh token outside the window = probable theft.
    await revokeGrant(db, row.grant_id, now);
    throw new OAuthError("invalid_grant", "refresh token was already used; the grant is revoked");
  }
  // Rotate. If a concurrent refresh of the same token won this UPDATE, that is
  // the race the grace window exists for, so this caller gets a pair as well.
  await db
    .prepare(`UPDATE oauth_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`)
    .bind(now.getTime(), tokenHash)
    .run();
  return issueTokenPair(db, row.grant_id, row.scope, now);
}

/** The token endpoint (RFC 6749 §3.2) — never throws; errors are RFC JSON. */
export async function handleTokenRequest(
  deps: TokenDeps,
  form: Record<string, string>,
  authorization: string | null,
): Promise<TokenHttpResult> {
  try {
    const client = await authenticateClient(deps.db, form, authorization, deps.fetchImpl);
    let body: OAuthTokenResponse;
    if (form.grant_type === "authorization_code") body = await exchangeCode(deps, client, form);
    else if (form.grant_type === "refresh_token") body = await rotateRefresh(deps, client, form);
    else {
      throw new OAuthError(
        "unsupported_grant_type",
        "grant_type must be authorization_code or refresh_token",
      );
    }
    return { status: 200, body, headers: NO_STORE };
  } catch (err) {
    const e = err instanceof OAuthError ? err : new OAuthError("server_error", "token request failed", 500);
    const headers: Record<string, string> = { ...NO_STORE };
    if (e.code === "invalid_client" && authorization?.startsWith("Basic ")) {
      headers["www-authenticate"] = 'Basic realm="brainz-oauth"';
    }
    return { status: e.status, body: e.body(), headers };
  }
}

/** RFC 7009 revocation: revokes the token's whole grant; 200 whatever happens to the token. */
export async function handleRevokeRequest(
  deps: TokenDeps,
  form: Record<string, string>,
  authorization: string | null,
): Promise<TokenHttpResult> {
  try {
    const client = await authenticateClient(deps.db, form, authorization, deps.fetchImpl);
    if (!form.token) throw new OAuthError("invalid_request", "token is required");
    const row = await deps.db
      .prepare(
        `SELECT g.id, g.client_id FROM oauth_token t JOIN oauth_grant g ON g.id = t.grant_id WHERE t.token_hash = ?`,
      )
      .bind(await sha256Hex(form.token))
      .first<{ id: string; client_id: string }>();
    if (row && row.client_id === client.clientId) await revokeGrant(deps.db, row.id, deps.now);
    return { status: 200, body: {}, headers: NO_STORE };
  } catch (err) {
    const e = err instanceof OAuthError ? err : new OAuthError("server_error", "revocation failed", 500);
    return { status: e.status, body: e.body(), headers: NO_STORE };
  }
}

// ---------------------------------------------------------- /mcp access

export function isAccessTokenFormat(token: string): boolean {
  return /^bzat_[A-Za-z0-9]{40}$/.test(token);
}

export type AccessResolution =
  | { ok: true; userId: string; vaultId: string; ownerId: string; role: VaultRole; grantId: string }
  | { ok: false; reason: "invalid" | "owner_expired" };

/**
 * Resolve an access token for /mcp. The user's CURRENT membership decides the
 * role (and so the surface); a removed member, a revoked grant, an expired
 * token or an expired provisional owner all fail.
 */
export async function resolveAccessToken(db: OAuthDb, token: string, now: Date): Promise<AccessResolution> {
  if (!isAccessTokenFormat(token)) return { ok: false, reason: "invalid" };
  const row = await db
    .prepare(
      `SELECT g.id AS grant_id, g.user_id, g.vault_id, g.revoked_at, t.expires_at,
              v.owner_id, o.expires_at AS owner_expires_at, m.role
       FROM oauth_token t
       JOIN oauth_grant g ON g.id = t.grant_id
       JOIN vault v ON v.id = g.vault_id
       JOIN user o ON o.id = v.owner_id
       LEFT JOIN vault_member m ON m.vault_id = g.vault_id AND m.user_id = g.user_id
       WHERE t.token_hash = ? AND t.kind = 'access'`,
    )
    .bind(await sha256Hex(token))
    .first<{
      grant_id: string;
      user_id: string;
      vault_id: string;
      revoked_at: number | null;
      expires_at: number;
      owner_id: string;
      owner_expires_at: number | null;
      role: VaultRole | null;
    }>();
  if (!row || row.revoked_at !== null || row.expires_at < now.getTime() || !row.role) {
    return { ok: false, reason: "invalid" };
  }
  if (isOwnerExpired(row.owner_expires_at === null ? null : new Date(row.owner_expires_at), now)) {
    return { ok: false, reason: "owner_expired" };
  }
  return {
    ok: true,
    userId: row.user_id,
    vaultId: row.vault_id,
    ownerId: row.owner_id,
    role: row.role,
    grantId: row.grant_id,
  };
}

// ------------------------------------------------------ lazy-auth gate

/**
 * Does this JSON-RPC body (single message or batch) call a tool that is NOT
 * in the public allow-list? Such a call without a token must get an HTTP 401
 * challenge before the MCP SDK runs — a 200 `isError` never starts sign-in.
 */
export function callsGatedTool(body: unknown, publicTools: ReadonlySet<string>): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((msg) => {
    if (!msg || typeof msg !== "object") return false;
    const m = msg as { method?: unknown; params?: { name?: unknown } };
    if (m.method !== "tools/call") return false;
    const name = m.params?.name;
    return typeof name === "string" && !publicTools.has(name);
  });
}

// ---------------------------------------------------------------- CSRF

const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];

/**
 * SvelteKit's built-in cross-site form-POST check, re-applied in hooks because
 * svelte.config.js trusts all origins (the built-in check runs before hooks and
 * cannot exempt a path). Identical rule, minus CSRF_EXEMPT_PATHS.
 */
export function isCrossSiteFormPost(request: Request, url: URL): boolean {
  if (CSRF_EXEMPT_PATHS.has(url.pathname)) return false;
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  const type = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!FORM_TYPES.includes(type)) return false;
  return request.headers.get("origin") !== url.origin;
}

// ---------------------------------------------------------------- HTTP

/**
 * JSON response for the OAuth endpoints. CORS-open: discovery, registration
 * and token calls may come from browser-based MCP clients (e.g. the MCP
 * Inspector), and none of these endpoints read cookies.
 */
export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...headers,
    },
  });
}

/** CORS preflight answer for the OAuth endpoints. */
export function oauthPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
      "access-control-max-age": "86400",
    },
  });
}
