/** DELETE /api/vaults/:vaultId/invites/:inviteId — revoke (owner only). */
import { guarded, HttpError, requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { inviteDbFrom, revokeInvite } from "$lib/server/invites";
import { requireVaultAccess } from "$lib/server/vault-access";

export const DELETE = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const db = inviteDbFrom(createDb(requirePlatform(event).env.DB));
  const revoked = await revokeInvite(db, vault.id, event.params.inviteId!);
  if (!revoked) throw new HttpError(404, "invite not found");
  return new Response(null, { status: 204 });
});
