/**
 * POST /api/vaults/:vaultId/concepts/:id/membership — atomically replace the
 * concept's container of one type (SPEC-CLOUD.md "Burndown"). Editor+.
 * The VaultDO reads the current relations itself, so a client's stale graph
 * cache can never drop links added since it last refreshed.
 */
import { json } from "@sveltejs/kit";
import { conceptMembershipRequestSchema } from "@brainz/contracts";
import { guarded, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { role: "editor" });
  const input = await parseBody(event, conceptMembershipRequestSchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { concept } = await client.setMembership({ id: event.params.id!, ...input });
  return json(concept);
});
