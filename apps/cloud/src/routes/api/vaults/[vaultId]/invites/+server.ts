/**
 * GET/POST /api/vaults/:vaultId/invites — owner only, session only.
 *
 * POST creates an invite and returns `{invite, url}` — the ONE and only time
 * the invite URL appears on this surface (it is also emailed). The GET list
 * deliberately NEVER returns urls: tokens are SHA-256-hashed at rest, so the
 * server cannot reproduce a link after creation. (This is a deliberate
 * hardening deviation from SPEC-CLOUD.md's casual "pending-invite list with
 * copy-link": copy-link is served by the create/resend responses instead.)
 */
import { json } from "@sveltejs/kit";
import { inviteCreateRequestSchema } from "@brainz/contracts";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { createInvite, inviteDbFrom, inviteDepsFrom, listInvites } from "$lib/server/invites";
import { requireUser, requireVaultAccess } from "$lib/server/vault-access";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const db = inviteDbFrom(createDb(requirePlatform(event).env.DB));
  return json({ invites: await listInvites(db, vault.id, new Date()) });
});

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const user = requireUser(event);
  const body = await parseBody(event, inviteCreateRequestSchema);
  const deps = inviteDepsFrom(event);
  const result = await createInvite(deps, {
    vaultId: vault.id,
    email: body.email,
    role: body.role,
    invitedByUserId: user.id,
    invitedByName: user.name,
  });
  if (!result.ok) throw new HttpError(result.status, result.message);
  return json({ invite: result.invite, url: result.url }, { status: 201 });
});
