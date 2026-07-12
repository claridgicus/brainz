/** GET /api/public/:token/concepts/:id — anonymous, read-only single concept. */
import { json } from "@sveltejs/kit";
import { guarded, HttpError, requirePlatform } from "$lib/server/api-util";
import { requirePublicVault } from "$lib/server/public-read";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const vault = await requirePublicVault(event);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { concept } = await client.getConcept(event.params.id!);
  if (!concept) throw new HttpError(404, `no concept with id "${event.params.id}"`);
  const { neighbors: _neighbors, ...wire } = concept;
  return json(wire);
});
