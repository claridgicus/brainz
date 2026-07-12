/**
 * PATCH/DELETE /api/vaults/:vaultId/types/:key — edit or remove a concept type.
 * PATCH: update label/color/weight/order/hidden of ANY type (built-in or custom)
 *        — editor+. Re-weighting immediately shifts the type's zoom-LOD tier +
 *        node size; hiding drops it from the graph/chips.
 * DELETE: remove a CUSTOM type — editor+. Built-ins can't be deleted (hide them
 *        instead → 400); a type still used by concepts is blocked (400) until the
 *        concepts are reassigned.
 */
import { json } from "@sveltejs/kit";
import { conceptTypeUpdateRequestSchema } from "@brainz/contracts";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const PATCH = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { role: "editor" });
  const patch = await parseBody(event, conceptTypeUpdateRequestSchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { type } = await client.updateType(event.params.key!, patch);
  return json(type);
});

export const DELETE = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { role: "editor" });
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { deleted } = await client.deleteType(event.params.key!);
  if (!deleted) throw new HttpError(404, `no type with key "${event.params.key}"`);
  return new Response(null, { status: 204 });
});
