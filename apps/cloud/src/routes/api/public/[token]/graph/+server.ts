/** GET /api/public/:token/graph → {nodes, edges} (anonymous, read-only). */
import { json } from "@sveltejs/kit";
import { guarded, requirePlatform } from "$lib/server/api-util";
import { requirePublicVault } from "$lib/server/public-read";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const vault = await requirePublicVault(event);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(await client.graph());
});
