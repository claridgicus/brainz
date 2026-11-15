/** GET/POST /api/vaults/:vaultId/tasks — list task concepts and create a task. */
import { json } from "@sveltejs/kit";
import { taskCreateRequestSchema, tasksQuerySchema } from "@brainz/contracts";
import { createTaskRelations } from "@brainz/engine";
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
  // Board mutations are session-auth (creating work is a human/UI action);
  // Wave M: task creation is a write — editor+ (viewers are read-only).
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "editor",
  });
  const input = await parseBody(event, taskCreateRequestSchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  const { concept } = await client.upsertConcept({
    title: input.title,
    body: input.body,
    type: "task",
    taskStatus: "open",
    tags: input.tags,
    codeAreas: input.codeAreas,
    relations: createTaskRelations(input),
  });
  return json(concept, { status: 201 });
});
