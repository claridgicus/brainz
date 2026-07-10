/** GET/POST /api/vaults/:vaultId/concepts — list (tool-compact metas) and create. */
import { json } from "@sveltejs/kit";
import { conceptUpsertRequestSchema } from "@brainz/contracts";
import { guarded, parseBody, parseQuery, requirePlatform } from "$lib/server/api-util";
import { listQuerySchema } from "$lib/server/concept-list-query";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const filter = parseQuery(event, listQuerySchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(await client.list(filter));
});

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const input = await parseBody(event, conceptUpsertRequestSchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { concept } = await client.upsertConcept(input);
  return json(concept, { status: 201 });
});
