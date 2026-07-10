/** GET /api/vaults/:vaultId/graph → {nodes, edges} (pending nodes flagged). */
import { json } from "@sveltejs/kit";
import { guarded, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(await client.graph());
});
