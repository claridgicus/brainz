/** GET/POST /api/vaults/:vaultId/tasks — list task concepts and create a task. */
import { json } from "@sveltejs/kit";
import { taskCreateRequestSchema, tasksQuerySchema } from "@brainz/contracts";
import { guarded, parseBody, parseQuery, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  const { taskStatus, domain } = parseQuery(event, tasksQuerySchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  return json(await client.listTasks({ taskStatus, domain }));
});

export const POST = guarded(async (event) => {
  // Board mutations are session-auth (creating work is a human/UI action).
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { sessionOnly: true });
  const input = await parseBody(event, taskCreateRequestSchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const relations: Record<string, string[]> = {};
  if (input.domain) relations.part_of = [input.domain];
  if (input.realizes && input.realizes.length > 0) relations.realizes = input.realizes;
  if (input.governedBy && input.governedBy.length > 0) relations.governed_by = input.governedBy;
  const { concept } = await client.upsertConcept({
    title: input.title,
    body: input.body,
    type: "task",
    taskStatus: "open",
    tags: input.tags,
    codeAreas: input.codeAreas,
    relations: Object.keys(relations).length > 0 ? relations : undefined,
  });
  return json(concept, { status: 201 });
});
