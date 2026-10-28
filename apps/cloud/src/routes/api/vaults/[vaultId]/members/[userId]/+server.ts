/**
 * PATCH/DELETE /api/vaults/:vaultId/members/:userId (session only).
 * PATCH — change a member's role: OWNER only.
 * DELETE — remove a member: OWNER only, EXCEPT self-leave (any member may
 * DELETE their own userId). Both refuse to strip the LAST owner (409) —
 * a vault must always have at least one owner ($lib/server/members).
 */
import { json } from "@sveltejs/kit";
import { memberUpdateRequestSchema } from "@brainz/contracts";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { changeMemberRole, membersDbFrom, removeMember } from "$lib/server/members";
import { requireUser, requireVaultAccess } from "$lib/server/vault-access";

export const PATCH = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const body = await parseBody(event, memberUpdateRequestSchema);
  const d1 = requirePlatform(event).env.DB;
  const db = membersDbFrom(createDb(d1), d1);
  const result = await changeMemberRole(db, {
    vaultId: vault.id,
    targetUserId: event.params.userId!,
    role: body.role,
  });
  if (!result.ok) throw new HttpError(result.status, result.message);
  return json({
    userId: result.member.userId,
    email: result.member.email,
    name: result.member.name,
    role: result.member.role,
    createdAt: result.member.createdAt.toISOString(),
  });
});

export const DELETE = guarded(async (event) => {
  // Self-leave must work for editors/viewers too, so require only membership
  // here; removeMember enforces "owners may remove others, anyone may remove
  // themselves" and the last-owner invariant.
  const { vault, role } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
  });
  const user = requireUser(event);
  const d1 = requirePlatform(event).env.DB;
  const db = membersDbFrom(createDb(d1), d1);
  const result = await removeMember(db, {
    vaultId: vault.id,
    targetUserId: event.params.userId!,
    callerUserId: user.id,
    callerRole: role,
  });
  if (!result.ok) throw new HttpError(result.status, result.message);
  return new Response(null, { status: 204 });
});
