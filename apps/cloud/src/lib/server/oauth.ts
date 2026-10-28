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
import { OPENAI_EGRESS_IPV4, OPENAI_EGRESS_IPV6 } from "./openai-egress";
import { expandIpv6, rateLimitBucket } from "./rate-limit";
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
/** Upper bound on the OAUTH_REFRESH_GRACE_SECONDS override. */
export const MAX_REFRESH_REUSE_GRACE_SECONDS = 300;

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

/**
 * DCR: registrations per client bucket per rolling hour. The bucket is the
 * IPv4 address or the IPv6 /48: an attacker holding one /48 can't rotate
 * through 65,536 /64s to multiply the per-bucket limit.
 */
export const REGISTER_RATE_LIMIT = 20;
/**
 * DCR: backstop across ALL non-directory traffic per rolling hour. High on
 * purpose — it only bounds table growth; the per-/48 limit does the work.
 */
export const REGISTER_GLOBAL_LIMIT = 20_000;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
/**
 * Grantless DCR clients idle (no authorize-page use) this long are purged.
 * Long, because native clients such as Claude Code cache their client_id.
 */
export const UNUSED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Codes are kept this long past expiry (a late replay still finds and revokes its grant). */
export const EXPIRED_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Revoked grants are kept this long, so their DCR client survives a reconnect. */
export const REVOKED_GRANT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A live grant left with no token this long after creation is dead (its last
 * refresh token expired). The margin covers the code exchange, which inserts
 * the grant before its first token pair.
 */
const TOKENLESS_GRANT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

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

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const groups = expandIpv6(ip);
  return groups ? groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) : null;
}

/** Is `ip` inside the IPv4 or IPv6 CIDR `cidr`? False on any mismatch or parse failure. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const v4ip = ipv4ToInt(ip);
  const v4net = ipv4ToInt(net);
  if (v4ip !== null && v4net !== null) {
    if (!(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((v4ip & mask) >>> 0) === ((v4net & mask) >>> 0);
  }
  const v6ip = ipv6ToBigInt(ip);
  const v6net = ipv6ToBigInt(net);
  if (v6ip === null || v6net === null || !(bits >= 0 && bits <= 128)) return false;
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return (v6ip & mask) === (v6net & mask);
}

/**
 * Anthropic's published egress range (160.79.104.0/21, per
 * https://claude.com/docs/connectors/building/authentication): Claude
 * registers a fresh DCR client on every new connection from these few
 * addresses, so they are exempt from the DCR limits.
 */
export function isAnthropicEgress(ip: string): boolean {
  return ipInCidr(ip, "160.79.104.0/21");
}

/**
 * OpenAI's published ChatGPT-integrations egress (plugins, connectors, GPT
 * Actions): https://openai.com/chatgpt-connectors.json, documented at
 * https://developers.openai.com/api/docs/guides/ip-addresses. Snapshot in
 * ./openai-egress (scripts/refresh-openai-egress.mjs regenerates it).
 */
export function isOpenAiEgress(ip: string): boolean {
  const list = ip.includes(":") ? OPENAI_EGRESS_IPV6 : OPENAI_EGRESS_IPV4;
  return list.some((cidr) => ipInCidr(ip, cidr));
}

/** Directory clients whose shared egress registers on every connection: DCR-limit exempt. */
export function isDirectoryEgress(ip: string): boolean {
  return isAnthropicEgress(ip) || isOpenAiEgress(ip);
}

/**
 * Durable limits on DCR: true when this registration should be refused.
 * `clientIp` is the raw client address (cf-connecting-ip). Directory egress
 * (Anthropic, OpenAI) is exempt; everyone else is bucketed (IPv4 address or
 * IPv6 /48) with REGISTER_RATE_LIMIT per bucket plus the REGISTER_GLOBAL_LIMIT
 * backstop. A request against an already-full bucket is refused WITHOUT
 * recording a row, so a flood can't grow the events table; otherwise it
 * records first and re-counts inclusively (TOCTOU-safe, like signup_events).
 */
export async function registrationThrottled(db: OAuthDb, clientIp: string, now: Date): Promise<boolean> {
  if (isDirectoryEgress(clientIp)) return false;
  const ip = rateLimitBucket(clientIp, 48);
  const since = now.getTime() - REGISTER_WINDOW_MS;
  const counts = async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN ip = ? THEN 1 ELSE 0 END) AS mine
         FROM oauth_register_events WHERE created_at > ?`,
      )
      .bind(ip, since)
      .first<{ total: number; mine: number | null }>();
    return { total: row?.total ?? 0, mine: row?.mine ?? 0 };
  };
  const before = await counts();
  if (before.mine >= REGISTER_RATE_LIMIT || before.total >= REGISTER_GLOBAL_LIMIT) return true;
  await db
    .prepare(`INSERT INTO oauth_register_events (id, ip, created_at) VALUES (?, ?, ?)`)
    .bind(crypto.randomUUID(), ip, now.getTime())
    .run();
  const after = await counts();
  return after.mine > REGISTER_RATE_LIMIT || after.total > REGISTER_GLOBAL_LIMIT;
}

/**
 * Housekeeping run alongside registration: drop DCR clients with no grant
 * (and no pending code) whose last authorize-page use — or registration, if
 * never used — is older than UNUSED_CLIENT_TTL_MS, plus registration events
 * past the rate window. Clients with a live grant are never purged.
 */
export async function purgeUnusedClients(db: OAuthDb, now: Date): Promise<void> {
  await db
    .prepare(
      `DELETE FROM oauth_client WHERE COALESCE(last_used_at, created_at) < ?
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

/**
 * The daily OAuth purge (Worker cron, see $lib/server/scheduled). In order:
 * codes a day past expiry; expired tokens and every token of a revoked grant;
 * grants revoked over REVOKED_GRANT_RETENTION_MS ago and live grants with no
 * token left; then purgeUnusedClients, which now sees those grants gone.
 * Superseded-but-unexpired tokens stay: presenting one is reuse and must
 * still revoke its grant. Each statement is idempotent, so a run cut short
 * is finished by the next one.
 */
export async function purgeExpiredOAuthState(db: OAuthDb, now: Date): Promise<void> {
  const t = now.getTime();
  await db.prepare(`DELETE FROM oauth_code WHERE expires_at < ?`).bind(t - EXPIRED_CODE_RETENTION_MS).run();
  await db
    .prepare(
      `DELETE FROM oauth_token WHERE expires_at < ?
         OR grant_id IN (SELECT id FROM oauth_grant WHERE revoked_at IS NOT NULL)`,
    )
    .bind(t)
    .run();
  // Dead grants: revoked long enough ago, or live but tokenless. Join rows and
  // tokens are deleted explicitly rather than trusting the FK cascade.
  const dead = `SELECT id FROM oauth_grant
    WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
       OR (revoked_at IS NULL AND created_at < ?
           AND NOT EXISTS (SELECT 1 FROM oauth_token tk WHERE tk.grant_id = oauth_grant.id))`;
  const deadBounds = [t - REVOKED_GRANT_RETENTION_MS, t - TOKENLESS_GRANT_MIN_AGE_MS];
  await db.prepare(`DELETE FROM oauth_grant_vault WHERE grant_id IN (${dead})`).bind(...deadBounds).run();
  await db.prepare(`DELETE FROM oauth_token WHERE grant_id IN (${dead})`).bind(...deadBounds).run();
  await db.prepare(`DELETE FROM oauth_grant WHERE id IN (${dead})`).bind(...deadBounds).run();
  await purgeUnusedClients(db, now);
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

/** Stamp a DCR client's last authorize-page use (keeps it out of the purge). */
export async function touchClient(db: OAuthDb, clientId: string, now: Date): Promise<void> {
  await db
    .prepare(`UPDATE oauth_client SET last_used_at = ? WHERE client_id = ?`)
    .bind(now.getTime(), clientId)
    .run();
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

/**
 * Which vaults a grant covers (SPEC-CLOUD.md "Multi-vault grants"):
 * - "single": one ticked vault — the original Wave OA surface, unchanged;
 * - "selected": several ticked vaults — vault tools take a required `vault` arg;
 * - "all": every vault the user is a member of, now or later — same surface.
 */
export type VaultScope = "single" | "selected" | "all";

/** The consent page's choice: the ticked vaults, or "all my vaults". */
export interface VaultSelection {
  /** "All my vaults, including ones I create or join later". */
  all: boolean;
  /** The ticked vault ids (non-empty unless `all`); the first is the grant's anchor. */
  vaultIds: readonly string[];
}

export function vaultScopeOf(selection: VaultSelection): VaultScope {
  if (selection.all) return "all";
  return selection.vaultIds.length > 1 ? "selected" : "single";
}

/**
 * Mint a single-use authorization code bound to client, redirect, PKCE, user
 * and the vault selection. `anchorVaultId` fills the NOT NULL `vault_id`
 * column: the first ticked vault, or for "all" any vault the user is in.
 */
export async function createAuthorizationCode(
  db: OAuthDb,
  args: {
    request: AuthorizeRequest;
    userId: string;
    selection: VaultSelection;
    anchorVaultId: string;
    now: Date;
  },
): Promise<string> {
  const code = randomToken("", 43);
  const { request, now, selection } = args;
  const scope = vaultScopeOf(selection);
  await db
    .prepare(
      `INSERT INTO oauth_code (code_hash, client_id, user_id, vault_id, redirect_uri, redirect_uri_explicit, code_challenge, scope, created_at, expires_at, vault_scope, vault_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(code),
      request.client.clientId,
      args.userId,
      args.anchorVaultId,
      request.redirectUri,
      request.redirectUriExplicit ? 1 : 0,
      request.codeChallenge,
      request.scope,
      now.getTime(),
      now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000,
      scope,
      scope === "all" ? null : JSON.stringify(selection.vaultIds),
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
  if (raw === undefined || raw === "" || !Number.isFinite(n) || n < 0) return REFRESH_REUSE_GRACE_SECONDS;
  return Math.min(n, MAX_REFRESH_REUSE_GRACE_SECONDS);
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

/** One vault a grant currently covers, with the user's CURRENT role in it. */
export interface GrantVault {
  id: string;
  slug: string;
  name: string;
  role: VaultRole;
  ownerId: string;
  /** The owner's provisional-account deadline (Wave G), if any. */
  ownerExpiresAt: Date | null;
}

/**
 * The vaults a grant covers right now: its `oauth_grant_vault` rows ("single" /
 * "selected") or every membership ("all"), always intersected with the user's
 * CURRENT memberships, so a removed member never reaches a vault. Ordered by
 * name. One row out (json_group_array) because the D1 port only has first().
 *
 * Deploy window: a "single" grant with NO join row covers its anchor
 * `vault_id`. Grants minted by the pre-multi-vault code between `migrations
 * apply` and the deploy have no row; without this they would cover nothing
 * and their next refresh would revoke them. This can't resurrect a vault that
 * member removal dropped: removal revokes a "single" grant outright
 * (memberRemovalStatements) instead of leaving it with zero rows.
 */
export async function coveredVaults(
  db: OAuthDb,
  grant: { id: string; userId: string; vaultScope: VaultScope; anchorVaultId: string | null },
): Promise<GrantVault[]> {
  const row = await db
    .prepare(
      `SELECT json_group_array(json_object(
                'id', id, 'slug', slug, 'name', name, 'role', role,
                'owner_id', owner_id, 'owner_expires_at', owner_expires_at)) AS vaults
       FROM (
         SELECT v.id, v.slug, v.name, m.role, v.owner_id, o.expires_at AS owner_expires_at
         FROM vault v
         JOIN vault_member m ON m.vault_id = v.id AND m.user_id = ?
         JOIN user o ON o.id = v.owner_id
         WHERE ? = 'all'
            OR v.id IN (SELECT vault_id FROM oauth_grant_vault WHERE grant_id = ?)
            OR (? = 'single' AND v.id = ? AND NOT EXISTS (SELECT 1 FROM oauth_grant_vault WHERE grant_id = ?))
         ORDER BY v.name, v.id
       )`,
    )
    .bind(grant.userId, grant.vaultScope, grant.id, grant.vaultScope, grant.anchorVaultId, grant.id)
    .first<{ vaults: string }>();
  const parsed = JSON.parse(row?.vaults ?? "[]") as {
    id: string;
    slug: string;
    name: string;
    role: VaultRole;
    owner_id: string;
    owner_expires_at: number | null;
  }[];
  return parsed.map((v) => ({
    id: v.id,
    slug: v.slug,
    name: v.name,
    role: v.role,
    ownerId: v.owner_id,
    ownerExpiresAt: v.owner_expires_at === null ? null : new Date(v.owner_expires_at),
  }));
}

/** Does the user (still) belong to at least one of these vaults? Returns those they do. */
async function memberVaultsAmong(db: OAuthDb, userId: string, vaultIds: readonly string[]): Promise<string[]> {
  if (vaultIds.length === 0) return [];
  const row = await db
    .prepare(
      `SELECT json_group_array(vault_id) AS ids FROM vault_member
       WHERE user_id = ? AND vault_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, JSON.stringify(vaultIds))
    .first<{ ids: string }>();
  const member = new Set(JSON.parse(row?.ids ?? "[]") as string[]);
  // Keep the consent order (the first is the anchor).
  return vaultIds.filter((id) => member.has(id));
}

/** Any vault the user belongs to (the anchor of an "all" grant), or null. */
async function anyMemberVault(db: OAuthDb, userId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT vault_id FROM vault_member WHERE user_id = ? ORDER BY created_at, vault_id LIMIT 1`)
    .bind(userId)
    .first<{ vault_id: string }>();
  return row?.vault_id ?? null;
}

async function revokeGrant(db: OAuthDb, grantId: string, now: Date): Promise<void> {
  await db
    .prepare(`UPDATE oauth_grant SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now.getTime(), grantId)
    .run();
}

/**
 * Revoke every token issued from `parentHash` except `keep`, AND all of their
 * descendants (a recursive walk down parent_hash), so a superseded chain dies
 * whole even if it had already rotated. Insert-then-revoke-others: when two
 * issuances from one parent interleave, the worst case is both pairs revoked
 * (the client re-authorizes), never two live chains.
 */
export async function supersedeChildren(
  db: OAuthDb,
  parentHash: string,
  keep: readonly string[],
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `WITH RECURSIVE doomed(hash) AS (
         SELECT token_hash FROM oauth_token WHERE parent_hash = ? AND token_hash NOT IN (?, ?)
         UNION
         SELECT t.token_hash FROM oauth_token t JOIN doomed d ON t.parent_hash = d.hash
       )
       UPDATE oauth_token SET revoked_at = ? WHERE token_hash IN (SELECT hash FROM doomed) AND revoked_at IS NULL`,
    )
    .bind(parentHash, keep[0], keep[1], now.getTime())
    .run();
}

/**
 * Issue an access + refresh pair. `parentHash` is the refresh token it was
 * rotated from (null for the code exchange). With `supersedeSiblings`, every
 * OTHER pair issued from the same parent is revoked afterwards, so a parent
 * never has more than one live child chain (see rotateRefresh's grace path).
 */
async function issueTokenPair(
  db: OAuthDb,
  grantId: string,
  scope: string,
  now: Date,
  parentHash: string | null = null,
  supersedeSiblings = false,
): Promise<OAuthTokenResponse> {
  const access = randomToken(ACCESS_TOKEN_PREFIX);
  const refresh = randomToken(REFRESH_TOKEN_PREFIX);
  const [accessHash, refreshHash] = [await sha256Hex(access), await sha256Hex(refresh)];
  const insert = `INSERT INTO oauth_token (token_hash, grant_id, kind, created_at, expires_at, parent_hash) VALUES (?, ?, ?, ?, ?, ?)`;
  await db
    .prepare(insert)
    .bind(accessHash, grantId, "access", now.getTime(), now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000, parentHash)
    .run();
  await db
    .prepare(insert)
    .bind(refreshHash, grantId, "refresh", now.getTime(), now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000, parentHash)
    .run();
  if (supersedeSiblings && parentHash !== null) {
    await supersedeChildren(db, parentHash, [accessHash, refreshHash], now);
  }
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
  vault_scope: VaultScope;
  vault_ids: string | null;
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
  // Membership is re-checked at exchange: only vaults the user still belongs to
  // enter the grant, and a grant that would cover nothing is refused.
  const vaultScope: VaultScope = row.vault_scope ?? "single";
  let vaultIds: string[];
  if (vaultScope === "all") {
    const anchor = (await memberVaultsAmong(db, row.user_id, [row.vault_id]))[0] ?? (await anyMemberVault(db, row.user_id));
    vaultIds = anchor ? [anchor] : [];
  } else {
    const ticked = row.vault_ids ? (JSON.parse(row.vault_ids) as string[]) : [row.vault_id];
    vaultIds = await memberVaultsAmong(db, row.user_id, ticked);
  }
  if (vaultIds.length === 0) {
    throw new OAuthError("invalid_grant", "you no longer have access to that vault");
  }
  const grantId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO oauth_grant (id, client_id, user_id, vault_id, scope, created_at, vault_scope) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(grantId, client.clientId, row.user_id, vaultIds[0], row.scope, now.getTime(), vaultScope)
    .run();
  if (vaultScope !== "all") {
    for (const vaultId of vaultIds) {
      await db
        .prepare(`INSERT INTO oauth_grant_vault (grant_id, vault_id) VALUES (?, ?)`)
        .bind(grantId, vaultId)
        .run();
    }
  }
  await db.prepare(`UPDATE oauth_code SET grant_id = ? WHERE code_hash = ?`).bind(grantId, codeHash).run();
  return issueTokenPair(db, grantId, row.scope, now);
}

/**
 * Refresh-token rotation over a token FAMILY. Every refresh pair records its
 * parent (the refresh token it was rotated from), so a parent has at most one
 * live child chain:
 * - first use of a token rotates it (used_at) and issues one child pair;
 * - re-presenting a token rotated within the grace window (a concurrent
 *   refresh, or a retry after a lost response) issues a NEW child and revokes
 *   the earlier children (revoked_at) — allowed only while none of those
 *   children has itself been used, i.e. the chain hasn't moved on yet;
 * - anything else — a superseded (revoked) sibling, a rotated token past the
 *   window, or one whose child already rotated — is reuse: the grant dies.
 * So a thief replaying inside the window can at most displace the legitimate
 * chain, and the legitimate client's next refresh (now a revoked sibling)
 * trips reuse detection and revokes the grant.
 */
async function rotateRefresh(deps: TokenDeps, client: ResolvedClient, form: Record<string, string>) {
  const { db, now } = deps;
  if (!form.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
  const tokenHash = await sha256Hex(form.refresh_token);
  const row = await db
    .prepare(
      `SELECT t.expires_at, t.used_at, t.revoked_at AS token_revoked_at,
              g.id AS grant_id, g.client_id, g.user_id, g.vault_id, g.scope, g.revoked_at, g.vault_scope
       FROM oauth_token t JOIN oauth_grant g ON g.id = t.grant_id
       WHERE t.token_hash = ? AND t.kind = 'refresh'`,
    )
    .bind(tokenHash)
    .first<{
      expires_at: number;
      used_at: number | null;
      token_revoked_at: number | null;
      grant_id: string;
      client_id: string;
      user_id: string;
      vault_id: string | null;
      scope: string;
      revoked_at: number | null;
      vault_scope: VaultScope;
    }>();
  // Check the client BEFORE touching anything, so a token presented by the
  // wrong client cannot burn the legitimate client's grant.
  if (!row || row.client_id !== client.clientId) {
    throw new OAuthError("invalid_grant", "refresh token is invalid");
  }
  if (row.revoked_at !== null) throw new OAuthError("invalid_grant", "the grant was revoked");
  const reuse = async (): Promise<never> => {
    await revokeGrant(db, row.grant_id, now);
    throw new OAuthError("invalid_grant", "refresh token was already used; the grant is revoked");
  };
  // A sibling superseded by a grace re-issue: its chain was displaced.
  if (row.token_revoked_at !== null) return reuse();
  if (row.expires_at < now.getTime()) throw new OAuthError("invalid_grant", "refresh token expired");
  // A "single"/"selected" grant whose every vault is gone (membership lost,
  // vault deleted) is dead.
  const covered = await coveredVaults(db, {
    id: row.grant_id,
    userId: row.user_id,
    vaultScope: row.vault_scope,
    anchorVaultId: row.vault_id,
  });
  // An "all" grant with zero vaults stays alive (it covers vaults the user
  // creates or joins later): it rotates normally, and /mcp 401s until then.
  if (covered.length === 0 && row.vault_scope !== "all") {
    await revokeGrant(db, row.grant_id, now);
    throw new OAuthError("invalid_grant", "you no longer have access to that vault");
  }
  const graceReissue = async () => {
    const moved = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM oauth_token WHERE parent_hash = ? AND kind = 'refresh' AND used_at IS NOT NULL`,
      )
      .bind(tokenHash)
      .first<{ n: number }>();
    // The chain already moved past this token: replaying it is reuse.
    if ((moved?.n ?? 0) > 0) return reuse();
    return issueTokenPair(db, row.grant_id, row.scope, now, tokenHash, true);
  };
  if (row.used_at !== null) {
    const grace = deps.refreshGraceSeconds ?? REFRESH_REUSE_GRACE_SECONDS;
    if (now.getTime() - row.used_at <= grace * 1000) return graceReissue();
    return reuse();
  }
  const consumed = await db
    .prepare(`UPDATE oauth_token SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING token_hash`)
    .bind(now.getTime(), tokenHash)
    .first();
  // Lost the race to a concurrent refresh of the same token: a grace re-issue.
  if (!consumed) return graceReissue();
  // First use also supersedes siblings: if a concurrent grace re-issue of the
  // same parent already inserted its pair, the last insert wins (worst case
  // both die) — never two live chains.
  return issueTokenPair(db, row.grant_id, row.scope, now, tokenHash, true);
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
  | {
      ok: true;
      userId: string;
      grantId: string;
      vaultScope: VaultScope;
      /**
       * The vaults this call may use, with the CURRENT role in each. Never
       * empty. "single" grants have exactly one; multi-vault grants drop
       * vaults whose provisional owner has expired.
       */
      vaults: GrantVault[];
    }
  | { ok: false; reason: "invalid" | "owner_expired" | "no_vault" };

/**
 * Resolve an access token for /mcp. The user's CURRENT memberships decide
 * which vaults (and roles, so which surface) the call gets; a grant left with
 * no vault, a revoked grant, an expired token or (single-vault) an expired
 * provisional owner all fail.
 */
export async function resolveAccessToken(db: OAuthDb, token: string, now: Date): Promise<AccessResolution> {
  if (!isAccessTokenFormat(token)) return { ok: false, reason: "invalid" };
  const row = await db
    .prepare(
      `SELECT g.id AS grant_id, g.user_id, g.vault_id, g.vault_scope, g.revoked_at, t.expires_at, t.revoked_at AS token_revoked_at
       FROM oauth_token t
       JOIN oauth_grant g ON g.id = t.grant_id
       WHERE t.token_hash = ? AND t.kind = 'access'`,
    )
    .bind(await sha256Hex(token))
    .first<{
      grant_id: string;
      user_id: string;
      vault_id: string | null;
      vault_scope: VaultScope;
      revoked_at: number | null;
      expires_at: number;
      token_revoked_at: number | null;
    }>();
  if (!row || row.revoked_at !== null || row.token_revoked_at !== null || row.expires_at < now.getTime()) {
    return { ok: false, reason: "invalid" };
  }
  const covered = await coveredVaults(db, {
    id: row.grant_id,
    userId: row.user_id,
    vaultScope: row.vault_scope,
    anchorVaultId: row.vault_id,
  });
  // An "all" grant between vaults is alive but has nothing to serve yet.
  if (covered.length === 0) return { ok: false, reason: row.vault_scope === "all" ? "no_vault" : "invalid" };
  const live = covered.filter((v) => !isOwnerExpired(v.ownerExpiresAt, now));
  // Every covered vault belongs to an expired provisional owner: the
  // actionable workspace-expired message, as before multi-vault grants.
  if (live.length === 0) return { ok: false, reason: "owner_expired" };
  return { ok: true, userId: row.user_id, grantId: row.grant_id, vaultScope: row.vault_scope, vaults: live };
}

// ------------------------------------------------- multi-vault upkeep

/**
 * Before a vault row is deleted, for every grant ANCHORED on it
 * (oauth_grant.vault_id, ON DELETE SET NULL since migration 0014):
 * 1. move it onto another vault it still covers: "selected" grants to
 *    another ticked vault, "all" grants to any other vault the user belongs to;
 * 2. delete the "single" / "selected" grants with nowhere to go (their tokens
 *    cascade), exactly as before the anchor became nullable.
 * An "all" grant with nowhere to go keeps living: the delete sets its anchor
 * to NULL, /mcp 401s while it covers nothing, and it recovers when the user
 * creates or joins a vault. One batch, so the pair is atomic.
 */
export async function prepareGrantsForVaultDelete(
  db: OAuthDb & { batch(statements: readonly unknown[]): Promise<unknown> },
  vaultId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE oauth_grant SET vault_id = COALESCE(
           (SELECT gv.vault_id FROM oauth_grant_vault gv
             WHERE gv.grant_id = oauth_grant.id AND gv.vault_id <> ? LIMIT 1),
           CASE WHEN oauth_grant.vault_scope = 'all' THEN
             (SELECT m.vault_id FROM vault_member m
               WHERE m.user_id = oauth_grant.user_id AND m.vault_id <> ? LIMIT 1)
           END,
           vault_id)
         WHERE vault_id = ? AND vault_scope <> 'single'`,
      )
      .bind(vaultId, vaultId, vaultId),
    db.prepare(`DELETE FROM oauth_grant WHERE vault_id = ? AND vault_scope <> 'all'`).bind(vaultId),
  ]);
}

/**
 * The statements that remove a user from a vault, for ONE D1 batch (one
 * implicit transaction, so a failure never leaves a member gone but a grant
 * still pointing at the vault, or the reverse):
 * 1. revoke the user's "single" grants on that vault. Their only vault is
 *    gone, and leaving them with zero join rows would read as the deploy-window
 *    fallback ("cover vault_id"), restoring access if the user is re-added;
 * 2. drop the vault from the user's remaining grants' join rows ("selected"),
 *    so a re-add does not silently restore a connection's access. "all"
 *    grants follow membership by definition;
 * 3. delete the membership.
 * Generic over the statement type so members.ts passes real D1 and the tests
 * pass the migrated better-sqlite3 schema.
 */
export function memberRemovalStatements<S>(
  db: { prepare(query: string): { bind(...values: unknown[]): S } },
  args: { vaultId: string; userId: string; now: Date },
): [S, S, S] {
  const { vaultId, userId, now } = args;
  return [
    db
      .prepare(
        `UPDATE oauth_grant SET revoked_at = ?
         WHERE user_id = ? AND vault_scope = 'single' AND revoked_at IS NULL
           AND (vault_id = ? OR id IN (SELECT grant_id FROM oauth_grant_vault WHERE vault_id = ?))`,
      )
      .bind(now.getTime(), userId, vaultId, vaultId),
    db
      .prepare(
        `DELETE FROM oauth_grant_vault
         WHERE vault_id = ? AND grant_id IN (SELECT id FROM oauth_grant WHERE user_id = ?)`,
      )
      .bind(vaultId, userId),
    db.prepare(`DELETE FROM vault_member WHERE vault_id = ? AND user_id = ?`).bind(vaultId, userId),
  ];
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
