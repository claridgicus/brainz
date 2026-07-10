/** POST /api/vaults/:vaultId/context {query?, ids?, depth?, tokenBudget?} → ContextBundle. */
import { json } from "@sveltejs/kit";
import { contextRequestSchema } from "@brainz/contracts";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const input = await parseBody(event, contextRequestSchema);
  if (!input.query && (!input.ids || input.ids.length === 0)) {
    throw new HttpError(400, "context requires at least one of `query` or `ids`");
  }
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(await client.context(input));
});
