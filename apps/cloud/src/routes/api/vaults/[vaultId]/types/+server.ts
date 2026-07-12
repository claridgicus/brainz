/**
 * GET/POST /api/vaults/:vaultId/types — the per-vault concept-type registry.
 * GET: list all types (built-in + custom) — any member (viewer+) or bearer key.
 * POST: create a custom type — editor+ (viewers are read-only). Key is slugified
 * server-side; a custom type immediately appears in the graph palette/chips/LOD.
 */
import { json } from "@sveltejs/kit";
import { conceptTypeCreateRequestSchema } from "@brainz/contracts";
import { guarded, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(await client.listTypes());
});

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { role: "editor" });
  const input = await parseBody(event, conceptTypeCreateRequestSchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { type } = await client.createType(input);
  return json(type, { status: 201 });
});
