/**
 * GET/PUT/DELETE /api/vaults/:vaultId/concepts/:id.
 * GET: any member (viewer+) or bearer key; PUT/DELETE: editor+ (Wave M).
 */
import { json } from "@sveltejs/kit";
import { conceptUpsertRequestSchema } from "@brainz/contracts";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { concept } = await client.getConcept(event.params.id!);
  if (!concept) throw new HttpError(404, `no concept with id "${event.params.id}"`);
  // apiConceptSchema is strict: meta + timestamps + body (no neighbors/filePath).
  const { neighbors: _neighbors, ...wire } = concept;
  return json(wire);
});

export const PUT = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { role: "editor" });
  const input = await parseBody(event, conceptUpsertRequestSchema);
  if (input.id !== undefined && input.id !== event.params.id) {
    throw new HttpError(400, "body id does not match the URL");
  }
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { concept } = await client.upsertConcept({ ...input, id: event.params.id! });
  return json(concept);
});

export const DELETE = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { role: "editor" });
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { deleted } = await client.deleteConcept(event.params.id!);
  if (!deleted) throw new HttpError(404, `no concept with id "${event.params.id}"`);
  return new Response(null, { status: 204 });
});
