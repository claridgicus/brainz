/**
 * GET /api/vaults/:vaultId/stats.
 * Body is contract-exact (statsResponseSchema is strict); the vault's active
 * keyword index mode (fts5 | like) rides on the X-Brainz-Keyword-Index header.
 */
import { json } from "@sveltejs/kit";
import { guarded, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { keywordIndex, ...stats } = await client.stats();
  return json(stats, { headers: { "x-brainz-keyword-index": keywordIndex } });
});
