/**
 * GET/POST/DELETE /api/vaults/:vaultId/public — OWNER-only, SESSION-only public
 * access management (public vaults). Owner-gated per the Wave M role model; a
 * member with an insufficient role gets 403, a non-member 404, and bearer keys
 * are rejected (session-only, like keys/members/invites).
 *
 *   GET    → current status { enabled, createdAt } (owner-only).
 *   POST   → ENABLE: mint a token, return { token, url } ONCE (the only place
 *            the plaintext + /public/<token> URL ever appears).
 *   DELETE → DISABLE: clear the hash so the old link 404s (revocation), → 204.
 */
import { json } from "@sveltejs/kit";
import { guarded, requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import {
  disablePublicAccess,
  enablePublicAccess,
  publicStatusOf,
  publicUrl,
} from "$lib/server/public-vault";
import { requireVaultAccess } from "$lib/server/vault-access";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  return json(publicStatusOf(vault));
});

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const now = new Date();
  const { token, createdAt } = await enablePublicAccess(db, vault.id, now);
  const origin = platform.env.BETTER_AUTH_URL || event.url.origin;
  return json(
    {
      enabled: true as const,
      token,
      url: publicUrl(origin, token),
      createdAt: createdAt.toISOString(),
    },
    { status: 201 },
  );
});

export const DELETE = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const db = createDb(requirePlatform(event).env.DB);
  await disablePublicAccess(db, vault.id);
  return new Response(null, { status: 204 });
});
