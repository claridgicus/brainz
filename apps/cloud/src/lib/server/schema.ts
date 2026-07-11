/**
 * D1 control-plane schema (drizzle). Vault CONTENT does not live here — it
 * lives in each vault's Durable Object (see vault-do.ts). D1 holds only:
 * Better Auth tables, the vault registry, and API keys.
 *
 * The Better Auth tables follow the core schema from the Better Auth docs
 * (user / session / account / verification) for the drizzle sqlite adapter.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    // Kept for the Better Auth account schema; unused now that auth is
    // passwordless (magic-link only). No credential rows are written.
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
  },
  (t) => [uniqueIndex("vault_owner_slug_unique").on(t.ownerId, t.slug)],
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
