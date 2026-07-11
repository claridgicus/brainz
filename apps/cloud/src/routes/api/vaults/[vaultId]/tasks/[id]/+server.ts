/**
 * PATCH /api/vaults/:vaultId/tasks/:id — a Kanban card move.
 * `action`: take (claim), complete (done + outcome), reopen (back to open).
 * Session-auth only: board mutations are human/UI actions.
 */
import { json } from "@sveltejs/kit";
import { taskMoveRequestSchema } from "@brainz/contracts";
import { guarded, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const PATCH = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { sessionOnly: true });
  const move = await parseBody(event, taskMoveRequestSchema);
  const id = event.params.id!;
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);

  if (move.action === "take") {
    const { task } = await client.takeTask({ id, takenBy: move.takenBy });
    return json(task);
  }
  if (move.action === "complete") {
    const { task } = await client.completeTask({ id, outcome: move.outcome });
    return json(task);
  }
  const { task } = await client.reopenTask({ id });
  return json(task);
});
