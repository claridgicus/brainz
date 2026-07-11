/**
 * POST /api/vaults/:vaultId/invites/:inviteId/resend — owner only. Mints a
 * NEW token (the old emailed link stops working), extends the expiry, re-sends
 * the email, and returns `{invite, url}` with the fresh one-time URL.
 */
import { json } from "@sveltejs/kit";
import { guarded, HttpError } from "$lib/server/api-util";
import { inviteDepsFrom, resendInvite } from "$lib/server/invites";
import { requireVaultAccess } from "$lib/server/vault-access";

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const deps = inviteDepsFrom(event);
  const result = await resendInvite(deps, {
    vaultId: vault.id,
    inviteId: event.params.inviteId!,
  });
  if (!result.ok) throw new HttpError(result.status, result.message);
  return json({ invite: result.invite, url: result.url });
});
