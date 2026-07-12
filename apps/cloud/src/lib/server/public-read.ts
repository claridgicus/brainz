/**
 * Route helpers for the ANONYMOUS public-read surface (public vaults). These
 * resolve a `/public/<token>` request to its vault WITHOUT any session or bearer
 * key, enforcing the 404 discipline: an unknown/rotated/revoked/disabled token
 * is indistinguishable from a missing vault. The public surface is read-only —
 * concept/graph/search/context/stats ONLY — and never exposes members, keys,
 * invites, the owner, or any write path.
 */
import type { RequestEvent } from "@sveltejs/kit";
import { HttpError, requirePlatform } from "./api-util";
import { createDb, schema } from "./db";
import { resolvePublicVault } from "./public-vault";

/**
 * Resolve the `[token]` route param to its public vault, or throw 404. The
 * 404 (never 403) keeps the surface non-enumerable: a valid-but-not-public
 * token reads exactly like a made-up one.
 */
export async function requirePublicVault(
  event: RequestEvent,
): Promise<typeof schema.vault.$inferSelect> {
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const vault = await resolvePublicVault(db, event.params.token ?? "");
  if (!vault) throw new HttpError(404, "not found");
  return vault;
}
