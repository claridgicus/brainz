/**
 * D1 control-plane schema (drizzle). Vault CONTENT does not live here — it
 * lives in each vault's Durable Object (see vault-do.ts). D1 holds only:
 * Better Auth tables, the vault registry, and API keys.
 *
 * The Better Auth tables follow the core schema from the Better Auth docs
 * (user / session / account / verification) for the drizzle sqlite adapter.
 */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ------------------------------------------------------------ Better Auth

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  /**
   * Wave G: provisional (agent-signed-up, unclaimed) accounts carry an expiry
   * (~7 days from signup); bearer auth rejects keys of expired owners. NULL =
   * permanent (human-created, or claimed via the /claim approval flow — the
   * ONLY path that clears it).
   */
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    idToken: text("id_token"),
    // Better Auth scrypt hash. Set only on `credential` rows for
    // operator-provisioned reviewer accounts (Wave OA,
    // scripts/reviewer-account.mjs); users stay passwordless.
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  // One account row per (user, provider) — a user has at most one OAuth account
  // per provider. (Left in place from the credential era; harmless now.)
  (t) => [uniqueIndex("account_user_id_provider_id_unique").on(t.userId, t.providerId)],
);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ------------------------------------------------------------------ vaults

/** Vault registry. `id` is the Durable Object name: env.VAULT_DO.idFromName(vault.id). */
export const vault = sqliteTable(
  "vault",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Set when the onboard flow completes; mirrored in the vault's DO meta. */
    onboardedAt: integer("onboarded_at", { mode: "timestamp_ms" }),
    /**
     * Last sync point — set at onboard-complete (the initial baseline) and on
     * every `sync {complete}`; mirrored in the vault's DO meta (last_synced_at).
     * The DO meta is the tool-facing source of truth; this column is the D1
     * control-plane mirror (like onboarded_at). Null → never synced.
     */
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    /**
     * Public read-only access (anonymous VIEWER via an unguessable token).
     * `publicEnabled` gates it; `publicTokenHash` is the SHA-256 of the 32-byte
     * token (only the hash is stored — plaintext shown once at enable/rotate);
     * `publicCreatedAt` stamps when the current token was minted. Disable clears
     * the hash; rotate swaps it (old link dies). See $lib/server/public-vault.
     */
    publicEnabled: integer("public_enabled", { mode: "boolean" }).notNull().default(false),
    publicTokenHash: text("public_token_hash"),
    publicCreatedAt: integer("public_created_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("vault_owner_slug_unique").on(t.ownerId, t.slug),
    // Public tokens resolve a vault by hash on the anonymous read path; the
    // unique index keeps that lookup fast and prevents hash collisions.
    uniqueIndex("vault_public_token_hash_unique").on(t.publicTokenHash),
  ],
);

// -------------------------------------------------- vault membership (Wave M)

/**
 * Vault membership — the ACCESS SOURCE OF TRUTH for session users (Wave M).
 * Roles: "owner" | "editor" | "viewer" (vaultRoleSchema in @brainz/contracts).
 * Every vault creator gets an `owner` row at creation (backfilled for
 * pre-Wave-M vaults in the migration); `vault.owner_id` remains the canonical
 * creator marker but access checks go through THIS table.
 */
export const vaultMember = sqliteTable(
  "vault_member",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vault.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("vault_member_vault_id_user_id_unique").on(t.vaultId, t.userId),
    index("vault_member_user_id").on(t.userId),
  ],
);

/**
 * Email invites to a vault (Wave M). `email` is normalized-lowercase (the
 * shared normalizeEmail choke-point); only the SHA-256 hash of the 32-byte
 * token is stored (the one-time URL is shown at create/resend and emailed);
 * tokens live 14 days; `accepted_at` stamps consumption (single-use). A new
 * invite for the same (vault, email) supersedes the pending one.
 */
export const vaultInvite = sqliteTable(
  "vault_invite",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vault.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("vault_invite_vault_id").on(t.vaultId),
    index("vault_invite_email").on(t.email),
  ],
);

// -------------------------------------------------------- magic-link events

/**
 * One row per magic-link REQUEST, keyed by email and client IP — the basis of
 * the durable, D1-backed magic-link rate limit (5/hour/email, 20/hour/IP).
 * Better Auth's own limiter is in-memory and resets per Worker instance, so it
 * can't stop mail-bombing across the fleet; this table can. Indexes on
 * (email, created_at) and (ip, created_at) keep the window counts fast.
 */
export const magicLinkEvent = sqliteTable(
  "magic_link_events",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    ip: text("ip").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("magic_link_events_email_created_at").on(t.email, t.createdAt),
    index("magic_link_events_ip_created_at").on(t.ip, t.createdAt),
  ],
);

// ----------------------------------------------------------- account claims

/**
 * Pending claim-to-persist requests (Wave G): an agent asks to attach its
 * provisional workspace to a human's email; the human approves via an EMAILED
 * `/claim/<token>` link. Only the SHA-256 hash of the 32-byte token is stored;
 * tokens live 24 h; a new request supersedes (deletes) the user's prior
 * pending claims; `approved_at` stamps consumption (single-use). Indexes:
 * token_hash is the lookup key (unique), user_id serves the supersede/cleanup
 * queries, email serves audit/abuse queries.
 */
export const accountClaim = sqliteTable(
  "account_claims",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("account_claims_user_id").on(t.userId),
    index("account_claims_email").on(t.email),
  ],
);

// ------------------------------------------------------------ signup events

/**
 * One row per successful public-MCP signup, keyed by client IP — the basis of
 * the per-IP rate limit (5 signups/hour). The (ip, created_at) index keeps the
 * window count query index-friendly.
 */
export const signupEvent = sqliteTable(
  "signup_events",
  {
    id: text("id").primaryKey(),
    ip: text("ip").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("signup_events_ip_created_at").on(t.ip, t.createdAt)],
);

// ------------------------------------------------------- public-read events

/**
 * One row per ANONYMOUS public-vault MCP READ (public vaults), keyed by client
 * IP — the basis of the per-IP rate limit on the unauthenticated read surface
 * (a public token is not a secret credential, so its /mcp reads are throttled
 * like signups). The (ip, created_at) index keeps the window count fast. Same
 * insert-then-count TOCTOU-safe pattern as signup_events.
 */
export const publicReadEvent = sqliteTable(
  "public_read_events",
  {
    id: text("id").primaryKey(),
    ip: text("ip").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("public_read_events_ip_created_at").on(t.ip, t.createdAt)],
);

// ---------------------------------------------------------------- api keys

/**
 * Per-vault API keys. Token format `bz_<32 rand>`; only the SHA-256 hash is
 * stored — the plaintext is shown exactly once at creation.
 */
export const apiKey = sqliteTable("api_key", {
  id: text("id").primaryKey(),
  vaultId: text("vault_id")
    .notNull()
    .references(() => vault.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
});

// ------------------------------------------------ dreaming spend controls

/**
 * Per-account daily ledger of operator-paid (Workers AI) dream spend. One row
 * per (vault owner, UTC day); `usd_micros` is integer micro-dollars so repeated
 * adds never drift. Written by the VaultDO after each REM step; BYOK calls are
 * never recorded. See $lib/server/dream-budget.
 */
export const dreamSpend = sqliteTable(
  "dream_spend",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** UTC `YYYY-MM-DD`. */
    day: text("day").notNull(),
    usdMicros: integer("usd_micros").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/**
 * One bring-your-own dream LLM key per user. The key is AES-GCM ciphertext
 * (BYOK_ENCRYPTION_KEY, user id as additional data); only `key_hint` is ever
 * shown back. `base_url` is set for OpenAI-compatible providers.
 */
export const llmKey = sqliteTable("llm_key", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** "anthropic" | "openai" (OpenAI-compatible). */
  provider: text("provider").notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  keyHint: text("key_hint").notNull(),
  baseUrl: text("base_url"),
  model: text("model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Operator flags flipped with `wrangler d1 execute` (no redeploy). Today:
 * `dreaming_kill_switch` = off | workers-ai | all (see apps/cloud/README.md).
 */
export const controlFlag = sqliteTable("control_flag", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// -------------------------------------------------- OAuth 2.1 (Wave OA)

/**
 * Dynamically registered OAuth clients (RFC 7591). Client-ID-metadata-document
 * clients (an https URL as client_id) are NOT stored; they are fetched at
 * authorize time. `client_secret_hash` is null for public (PKCE-only) clients.
 * `redirect_uris` is a JSON array. See $lib/server/oauth.
 */
export const oauthClient = sqliteTable("oauth_client", {
  clientId: text("client_id").primaryKey(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name"),
  redirectUris: text("redirect_uris").notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** Last authorize-page use; grantless clients idle 30 days are purged. */
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
});

/**
 * Authorization codes: SHA-256 hash at rest, 5-minute TTL, single-use
 * (`used_at`). `grant_id` records the grant the exchange produced so a replayed
 * code can revoke it. `client_id` is not a foreign key (CIMD clients are URLs).
 */
export const oauthCode = sqliteTable(
  "oauth_code",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vault.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    /** 1 when the authorize request carried redirect_uri, so the token request must repeat it. */
    redirectUriExplicit: integer("redirect_uri_explicit", { mode: "boolean" }).notNull().default(true),
    codeChallenge: text("code_challenge").notNull(),
    scope: text("scope").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    grantId: text("grant_id"),
    /** The grant's vault scope: "single" | "selected" | "all" (see oauthGrant.vaultScope). */
    vaultScope: text("vault_scope").notNull().default("single"),
    /** JSON array of the ticked vault ids ("single"/"selected"); null for "all". `vault_id` is the first. */
    vaultIds: text("vault_ids"),
    /**
     * SHA-256 of the authorize request (user, client, redirect, PKCE challenge,
     * state): one code per request, so a duplicate Approve gets the same code.
     * Null on codes minted before migration 0015.
     */
    requestKey: text("request_key"),
    /** The code is HMAC(secret, nonce); kept so a duplicate Approve can re-derive it. */
    codeNonce: text("code_nonce"),
  },
  (t) => [uniqueIndex("oauth_code_request_key").on(t.requestKey)],
);

/**
 * One consented grant = one user × one client × a vault set. Revoking it kills
 * every token. Which vaults it covers is `vault_scope`:
 * - "single": the one `oauth_grant_vault` row (the original Wave OA shape);
 * - "selected": the `oauth_grant_vault` rows (several ticked vaults);
 * - "all": every vault the user is a member of, now or later.
 * `vault_id` is only the ANCHOR: deleting a vault first re-anchors
 * multi-vault grants onto another covered vault and deletes "single" /
 * "selected" grants left with nothing (prepareGrantsForVaultDelete); an "all"
 * grant left with nothing keeps living with a NULL anchor.
 */
export const oauthGrant = sqliteTable(
  "oauth_grant",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * The anchor vault. Nullable + SET NULL (migration 0014) so an "all"
     * grant outlives the user's last vault; "single"/"selected" grants that
     * can't be re-anchored are deleted explicitly before the vault goes.
     */
    vaultId: text("vault_id").references(() => vault.id, { onDelete: "set null" }),
    scope: text("scope").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    vaultScope: text("vault_scope").notNull().default("single"),
  },
  (t) => [index("oauth_grant_user_id").on(t.userId)],
);

/**
 * The vaults a "single" or "selected" grant covers. Removing the user from a
 * vault deletes that vault's rows for their grants (members.ts), and a vault
 * delete cascades its rows, so a re-added member does not silently regain it.
 */
export const oauthGrantVault = sqliteTable(
  "oauth_grant_vault",
  {
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrant.id, { onDelete: "cascade" }),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vault.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.grantId, t.vaultId] }), index("oauth_grant_vault_vault_id").on(t.vaultId)],
);

/**
 * Access (`bzat_`) and refresh (`bzrt_`) tokens, SHA-256 hashed. A refresh
 * token's `used_at` is stamped when it rotates; presenting it again revokes
 * the grant (reuse detection). The daily cron deletes expired tokens and
 * those of revoked grants, then dead grants (oauth.purgeExpiredOAuthState).
 */
export const oauthToken = sqliteTable(
  "oauth_token",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrant.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    /**
     * Hash of the refresh token this pair was issued from (null for the
     * code-exchange pair). A grace re-issue revokes the other pairs with the
     * same parent, so the refresh family never splits into parallel chains.
     */
    parentHash: text("parent_hash"),
    /** Set when a sibling pair superseded this one; presenting it later = reuse. */
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("oauth_token_grant_id").on(t.grantId), index("oauth_token_parent_hash").on(t.parentHash)],
);

/**
 * One row per dynamic client registration, keyed by client IP — the durable
 * per-IP DCR limit (record-then-count, like signup_events). Anthropic's egress
 * range is exempt. Rows past the window are purged on registration.
 */
export const oauthRegisterEvent = sqliteTable(
  "oauth_register_events",
  {
    id: text("id").primaryKey(),
    ip: text("ip").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("oauth_register_events_ip_created_at").on(t.ip, t.createdAt)],
);
