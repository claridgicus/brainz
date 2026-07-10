/** GET /api/vaults/:vaultId/related/:id?depth=&limit= */
import { json } from "@sveltejs/kit";
import { relatedQuerySchema } from "@brainz/contracts";
import { guarded, parseQuery, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const q = parseQuery(event, relatedQuerySchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const result = await client.related({ id: event.params.id!, depth: q.depth, limit: q.limit });
  return json(result);
});
