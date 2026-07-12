/** GET /api/public/:token/search?q=&mode=&type=&product=&limit= — anonymous read. */
import { json } from "@sveltejs/kit";
import { searchQuerySchema } from "@brainz/contracts";
import { guarded, parseQuery, requirePlatform } from "$lib/server/api-util";
import { requirePublicVault } from "$lib/server/public-read";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const vault = await requirePublicVault(event);
  const q = parseQuery(event, searchQuerySchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(
    await client.search({
      query: q.q,
      mode: q.mode,
      type: q.type,
      product: q.product,
      limit: q.limit,
    }),
  );
});
