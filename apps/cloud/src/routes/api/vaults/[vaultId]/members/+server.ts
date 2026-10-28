/**
 * GET /api/vaults/:vaultId/members — list members (any member may look;
 * session only — the member roster is an admin-plane surface, not part of
 * the bearer-key data plane). POST does not exist: members only ever arrive
 * via invite accept (POST /api/invites/:token/accept).
 */
import { json } from "@sveltejs/kit";
import { guarded, requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { membersDbFrom } from "$lib/server/members";
import { requireVaultAccess } from "$lib/server/vault-access";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { sessionOnly: true });
  const d1 = requirePlatform(event).env.DB;
  const db = membersDbFrom(createDb(d1), d1);
  const members = await db.listMembers(vault.id);
  return json({
    members: members.map((m) => ({
      userId: m.userId,
      email: m.email,
      name: m.name,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});
