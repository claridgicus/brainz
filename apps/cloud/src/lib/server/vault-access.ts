/**
 * Vault access resolution for REST + MCP.
 *
 * Two credentials:
 * - Session cookie (locals.user): full access to the user's own vaults.
 * - Bearer `bz_` API key: scoped to exactly its vault, read/write data-plane
 *   only — key management and vault mutation stay session-only ("keys can't
 *   mint keys").
 *
 * Every lookup filters by owner/vault binding — other users' vaults are
 * indistinguishable from missing ones (404).
 */
import type { RequestEvent } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { hashApiKey, isApiKeyFormat, parseBearer } from "./api-keys";
import { HttpError, requirePlatform } from "./api-util";
import { createDb, schema } from "./db";

export interface VaultAccess {
  vault: typeof schema.vault.$inferSelect;
  via: "session" | "key";
}

/**
 * The 401 body for keys whose provisional owner expired unclaimed (Wave G).
 * Surfaced verbatim on both REST and /mcp bearer paths.
 */
export const WORKSPACE_EXPIRED_MESSAGE =
  "workspace expired unclaimed — sign up again, or ask your human to approve the claim email";

/**
 * Wave G expiry rule: a provisional owner (`expires_at` set by agent signup)
 * whose expiry has passed makes every key on their vaults unauthorized.
 * NULL = permanent account (human-created or claimed). Pure + exported for
 * unit testing.
 */
export function isOwnerExpired(ownerExpiresAt: Date | null, now: Date): boolean {
  return ownerExpiresAt !== null && ownerExpiresAt.getTime() < now.getTime();
}

/**
 * Resolve an api_key row (+vault) from a bearer token; null when invalid.
 *
 * This is the single bearer-auth chokepoint for BOTH surfaces — every REST
 * route goes through requireVaultAccess → resolveApiKey, and /mcp calls it
 * directly — so the Wave G owner-expiry rejection lives here: a key whose
 * vault owner is past `expires_at` throws a 401 HttpError with
 * WORKSPACE_EXPIRED_MESSAGE (a message-carrying rejection, unlike the silent
 * null for unknown keys).
 */
export async function resolveApiKey(
  event: RequestEvent,
): Promise<{ key: typeof schema.apiKey.$inferSelect; vault: typeof schema.vault.$inferSelect } | null> {
  const token = parseBearer(event.request.headers.get("authorization"));
  if (!token || !isApiKeyFormat(token)) return null;
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const keyHash = await hashApiKey(token);
  const rows = await db
    .select({ key: schema.apiKey, vault: schema.vault, ownerExpiresAt: schema.user.expiresAt })
    .from(schema.apiKey)
    .innerJoin(schema.vault, eq(schema.apiKey.vaultId, schema.vault.id))
    .innerJoin(schema.user, eq(schema.vault.ownerId, schema.user.id))
    .where(eq(schema.apiKey.keyHash, keyHash))
    .limit(1);
  if (rows.length === 0) return null;
  if (isOwnerExpired(rows[0].ownerExpiresAt, new Date())) {
    throw new HttpError(401, WORKSPACE_EXPIRED_MESSAGE);
  }
  // Touch last_used_at out of band; never block or fail the request on it.
  const touch = db
    .update(schema.apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKey.id, rows[0].key.id))
    .then(
      () => {},
      () => {},
    );
  platform.context.waitUntil(touch);
  return { key: rows[0].key, vault: rows[0].vault };
}

/**
 * Require access to `vaultId` (route param). Session owners get any of their
 * vaults; bearer keys get exactly their vault. `sessionOnly` restricts to
 * cookie sessions (vault mutation, key management).
 */
export async function requireVaultAccess(
  event: RequestEvent,
  vaultId: string,
  opts: { sessionOnly?: boolean } = {},
): Promise<VaultAccess> {
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);

  if (event.locals.user) {
    const rows = await db
      .select()
      .from(schema.vault)
      .where(and(eq(schema.vault.id, vaultId), eq(schema.vault.ownerId, event.locals.user.id)))
      .limit(1);
    if (rows.length === 0) throw new HttpError(404, "vault not found");
    return { vault: rows[0], via: "session" };
  }

  if (!opts.sessionOnly) {
    const resolved = await resolveApiKey(event);
    if (resolved) {
      if (resolved.vault.id !== vaultId) throw new HttpError(404, "vault not found");
      return { vault: resolved.vault, via: "key" };
    }
  }

  throw new HttpError(401, "authentication required");
}

/** Require a cookie session (401 otherwise) and return the user. */
export function requireUser(event: RequestEvent): NonNullable<App.Locals["user"]> {
  if (!event.locals.user) throw new HttpError(401, "authentication required");
  return event.locals.user;
}
