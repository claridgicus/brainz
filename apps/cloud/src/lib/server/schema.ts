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
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  // One account row per (user, provider) — a user has at most one credential
  // account. Defence in depth for the /claim redemption race: even if two
  // concurrent submissions both slipped past the app-level checks, the DB
  // rejects the second credential row.
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

// ------------------------------------------------------------ account claims

/**
 * Single-use claim tokens for agent-provisioned accounts (public MCP `signup`
 * tool). Only the SHA-256 hex hash of the token is stored; the plaintext
 * appears exactly once, inside the signup tool result's claimUrl. A claim is
 * redeemable while unexpired (created_at + 7 days) and unclaimed; redeeming it
 * sets the user's password (credential account row) and claimed_at.
 */
export const accountClaim = sqliteTable("account_claims", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
});

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
