/**
 * GET /api/vaults/:vaultId/burndown — task burndown for a scope (SPEC.md
 * "Burndown", SPEC-CLOUD.md "Burndown"). A read: session or bearer, viewers
 * allowed. Unknown scope ⇒ 404 (from the DO), bad query ⇒ 400.
 */
import { json } from "@sveltejs/kit";
import { burndownQuerySchema } from "@brainz/contracts";
import { guarded, parseQuery, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const query = parseQuery(event, burndownQuerySchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(await client.burndown(query));
});
