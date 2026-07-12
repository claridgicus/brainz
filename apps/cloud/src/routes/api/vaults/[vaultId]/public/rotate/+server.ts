/**
 * POST /api/vaults/:vaultId/public/rotate — OWNER-only, SESSION-only. Mint a
 * FRESH public token (overwriting the stored hash, so the previously issued
 * /public/<token> link stops resolving) and return the new plaintext + URL ONCE.
 * Enabling is idempotent here: rotate leaves the vault public with a new token.
 */
import { json } from "@sveltejs/kit";
import { guarded, requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { enablePublicAccess, publicUrl } from "$lib/server/public-vault";
import { requireVaultAccess } from "$lib/server/vault-access";

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const now = new Date();
  const { token, createdAt } = await enablePublicAccess(db, vault.id, now);
  const origin = platform.env.BETTER_AUTH_URL || event.url.origin;
  return json({
    enabled: true as const,
    token,
    url: publicUrl(origin, token),
    createdAt: createdAt.toISOString(),
  });
});
