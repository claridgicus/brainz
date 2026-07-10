/** GET/POST /api/vaults/:vaultId/concepts — list (tool-compact metas) and create. */
import { json } from "@sveltejs/kit";
import { conceptTypeSchema, conceptUpsertRequestSchema } from "@brainz/contracts";
import { z } from "zod";
import { guarded, parseBody, parseQuery, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

const listQuerySchema = z.object({
  product: z.string().optional(),
  // Full 10-type ontology (domain/story/spec/workflow included) — matches
  // upsert / MCP list_concepts / REST search, which all use conceptTypeSchema.
  type: conceptTypeSchema.optional(),
  tag: z.string().optional(),
});

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
