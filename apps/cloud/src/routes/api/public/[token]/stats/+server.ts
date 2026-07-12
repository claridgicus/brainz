/** GET /api/public/:token/stats — anonymous, read-only (public vaults). */
import { json } from "@sveltejs/kit";
import { guarded, requirePlatform } from "$lib/server/api-util";
import { requirePublicVault } from "$lib/server/public-read";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const vault = await requirePublicVault(event);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { keywordIndex, ...stats } = await client.stats();
  return json(stats, { headers: { "x-brainz-keyword-index": keywordIndex } });
});
