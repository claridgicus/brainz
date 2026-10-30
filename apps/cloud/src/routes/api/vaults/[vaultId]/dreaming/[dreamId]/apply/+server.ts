/**
 * POST /api/vaults/:vaultId/dreaming/:dreamId/apply — decide a proposed dream
 * (propose mode): approve `proposals` (omitted ⇒ all, [] ⇒ reject all), reject
 * the rest. Editor+. 400 when the dream has no pending proposals.
 */
import { json } from "@sveltejs/kit";
import { dreamApplyRequestSchema } from "@brainz/contracts";
import { guarded, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { role: "editor" });
  const { proposals } = await parseBody(event, dreamApplyRequestSchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(await client.dreamApply(event.params.dreamId!, proposals));
});
