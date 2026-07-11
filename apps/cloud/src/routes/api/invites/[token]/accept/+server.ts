/**
 * POST /api/invites/:token/accept — accept an invite as the signed-in user.
 * Requires a session whose email matches the invite's (case-insensitive via
 * the shared normalizeEmail choke-point). Single-use; expired/used/mismatch
 * are clear 4xx errors. Success → `{vaultId, slug, role, alreadyMember}`.
 */
import { json } from "@sveltejs/kit";
import { guarded, HttpError, requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { acceptInvite, inviteDbFrom } from "$lib/server/invites";
import { requireUser } from "$lib/server/vault-access";

export const POST = guarded(async (event) => {
  const user = requireUser(event);
  const db = inviteDbFrom(createDb(requirePlatform(event).env.DB));
  const result = await acceptInvite(
    db,
    { token: event.params.token!, userId: user.id, userEmail: user.email },
    new Date(),
  );
  if (!result.ok) {
    // 410 for a dead token, 403 for a live token held by the wrong account.
    throw new HttpError(result.reason === "invalid" ? 410 : 403, result.message);
  }
  return json({
    vaultId: result.vaultId,
    slug: result.slug,
    role: result.role,
    alreadyMember: result.alreadyMember,
  });
});
