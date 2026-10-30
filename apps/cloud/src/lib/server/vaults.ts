/**
 * Vault creation, shared by `POST /api/vaults`, the OAuth consent page's
 * "+ New vault" action and the MCP `create_vault` tool (SPEC-CLOUD.md
 * "Multi-vault grants" → "Creating a vault over MCP"): the same slug rules
 * (slugify the slug or the name, unique per owner), the same per-user limits,
 * and the same atomic insert of the vault plus its creator's `owner`
 * membership.
 *
 * Limits (abuse guard, every path): an account owns at most
 * MAX_VAULTS_PER_USER vaults (default 20) and creates at most
 * VAULT_CREATE_RATE_LIMIT per rolling hour (default 10). The hourly count is
 * the owner's vaults whose `created_at` falls in the last hour, so the limit
 * stores nothing new (a vault deleted within the hour stops counting; deletes
 * need the dashboard and only free a slot). Both are checked INSIDE the D1
 * batch: the vault row is inserted only when the owner is under both limits
 * and the slug is free, and every later statement (membership, the caller's
 * `also` rows) inserts only if that vault row exists. D1 runs a batch as one
 * transaction, so concurrent creates can't overshoot either limit. When
 * nothing was inserted, a follow-up read names the reason (409 slug, 403 cap,
 * 429 rate).
 */
import type { vaultCreateRequestSchema } from "@brainz/contracts";
import { slugify } from "@brainz/engine";
import type { z } from "zod";
import { HttpError } from "./api-util";
import type { schema } from "./db";
import { RATE_WINDOW_MS } from "./rate-limit";

type VaultCreateRequest = z.infer<typeof vaultCreateRequestSchema>;

export type VaultRow = typeof schema.vault.$inferSelect;

/** Default cap on vaults one account owns (wrangler var MAX_VAULTS_PER_USER). */
export const DEFAULT_MAX_VAULTS_PER_USER = 20;
/** Default vaults one account may create per rolling hour (wrangler var VAULT_CREATE_RATE_LIMIT). */
export const DEFAULT_VAULT_CREATE_RATE_LIMIT = 10;

export interface VaultLimits {
  maxVaultsPerUser: number;
  createsPerHour: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The creation limits from env vars, falling back to the defaults on a missing or bad value. */
export function vaultLimitsFromEnv(env: {
  MAX_VAULTS_PER_USER?: string;
  VAULT_CREATE_RATE_LIMIT?: string;
}): VaultLimits {
  return {
    maxVaultsPerUser: positiveInt(env.MAX_VAULTS_PER_USER, DEFAULT_MAX_VAULTS_PER_USER),
    createsPerHour: positiveInt(env.VAULT_CREATE_RATE_LIMIT, DEFAULT_VAULT_CREATE_RATE_LIMIT),
  };
}

/** A bound D1 statement, as `prepare().bind()` returns it (real D1 or the test fake). */
export interface BoundStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

/** The D1 surface vault creation needs. */
export interface VaultCreateDb {
  prepare(query: string): { bind(...values: unknown[]): BoundStatement };
  batch(statements: readonly BoundStatement[]): Promise<unknown>;
}

export interface CreateVaultOptions {
  limits: VaultLimits;
  now?: Date;
  /**
   * Extra statements for the same batch, built for the new vault's id. Guard
   * each with `WHERE EXISTS (SELECT 1 FROM vault WHERE id = ?)` (see
   * `ifVaultCreated`) so it applies only when the vault was created.
   */
  also?: (vaultId: string) => readonly BoundStatement[];
}

/** SQL suffix for an `also` statement: bind the new vault id once more. */
export const IF_VAULT_CREATED = "WHERE EXISTS (SELECT 1 FROM vault WHERE id = ?)";

/**
 * Create a vault owned by `ownerId`. Throws HttpError 400 (no slug), 409
 * (slug taken), 403 (vault cap) or 429 (hourly limit).
 */
export async function createVault(
  db: VaultCreateDb,
  ownerId: string,
  body: VaultCreateRequest,
  opts: CreateVaultOptions,
): Promise<VaultRow> {
  const slug = slugify(body.slug ?? body.name);
  if (!slug) throw new HttpError(400, "could not derive a slug");
  const now = opts.now ?? new Date();
  const windowStart = now.getTime() - RATE_WINDOW_MS;
  const { maxVaultsPerUser, createsPerHour } = opts.limits;

  const vault: VaultRow = {
    id: crypto.randomUUID(),
    ownerId,
    slug,
    name: body.name,
    createdAt: now,
    onboardedAt: null,
    lastSyncedAt: null,
    // New vaults start private; public access is opt-in via settings.
    publicEnabled: false,
    publicTokenHash: null,
    publicCreatedAt: null,
  };

  try {
    await db.batch([
      // The gate: the vault row exists only if every limit passed.
      db
        .prepare(
          `INSERT INTO vault (id, owner_id, slug, name, created_at, public_enabled)
           SELECT ?, ?, ?, ?, ?, 0
           WHERE (SELECT COUNT(*) FROM vault WHERE owner_id = ? AND created_at > ?) < ?
             AND (SELECT COUNT(*) FROM vault WHERE owner_id = ?) < ?
             AND NOT EXISTS (SELECT 1 FROM vault WHERE owner_id = ? AND slug = ?)`,
        )
        .bind(vault.id, ownerId, slug, vault.name, now.getTime(), ownerId, windowStart, createsPerHour, ownerId, maxVaultsPerUser, ownerId, slug),
      db
        .prepare(
          `INSERT INTO vault_member (id, vault_id, user_id, role, created_at)
           SELECT ?, ?, ?, 'owner', ? ${IF_VAULT_CREATED}`,
        )
        .bind(crypto.randomUUID(), vault.id, ownerId, now.getTime(), vault.id),
      ...(opts.also?.(vault.id) ?? []),
    ]);
  } catch (err) {
    // vault_owner_slug_unique: a concurrent create took the slug first.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new HttpError(409, `a vault with slug "${slug}" already exists`);
    }
    throw err;
  }

  const created = await db.prepare(`SELECT 1 AS ok FROM vault WHERE id = ?`).bind(vault.id).first<{ ok: number }>();
  if (created) return vault;

  const why = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM vault WHERE owner_id = ? AND slug = ?) AS clash,
         (SELECT COUNT(*) FROM vault WHERE owner_id = ?) AS owned,
         (SELECT COUNT(*) FROM vault WHERE owner_id = ? AND created_at > ?) AS recent`,
    )
    .bind(ownerId, slug, ownerId, ownerId, windowStart)
    .first<{ clash: number; owned: number; recent: number }>();
  if (why && why.clash > 0) throw new HttpError(409, `a vault with slug "${slug}" already exists`);
  if (why && why.owned >= maxVaultsPerUser) {
    throw new HttpError(
      403,
      `vault limit reached: an account can own at most ${maxVaultsPerUser} vaults; delete one to create another`,
    );
  }
  throw new HttpError(
    429,
    `too many vaults created: at most ${createsPerHour} per hour; try again later`,
  );
}
