/** GET /api/vaults/:vaultId/search?q=&mode=&type=&product=&limit= */
import { json } from "@sveltejs/kit";
import { searchQuerySchema } from "@brainz/contracts";
import { guarded, parseQuery, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const q = parseQuery(event, searchQuerySchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const result = await client.search({
    query: q.q,
    mode: q.mode,
    type: q.type,
    product: q.product,
    limit: q.limit,
  });
  return json(result);
});
