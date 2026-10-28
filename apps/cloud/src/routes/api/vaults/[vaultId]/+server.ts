/**
 * GET/PATCH/DELETE /api/vaults/:vaultId.
 * GET: any member (or the vault's bearer key, which reads as role "editor").
 * PATCH/DELETE: OWNER role, session only (Wave M role gates).
 * DELETE destroys the vault's DO storage and cascades api keys + members.
 */
import { json } from "@sveltejs/kit";
import { vaultUpdateRequestSchema } from "@brainz/contracts";
import { slugify } from "@brainz/engine";
import { and, count, eq, ne } from "drizzle-orm";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { prepareGrantsForVaultDelete } from "$lib/server/oauth";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

async function memberCountOf(db: ReturnType<typeof createDb>, vaultId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(schema.vaultMember)
    .where(eq(schema.vaultMember.vaultId, vaultId));
  return rows[0]?.n ?? 1;
}

export const GET = guarded(async (event) => {
  const { vault, role } = await requireVaultAccess(event, event.params.vaultId!);
  const db = createDb(requirePlatform(event).env.DB);
  return json({
    id: vault.id,
    slug: vault.slug,
    name: vault.name,
    createdAt: vault.createdAt.toISOString(),
    role,
    memberCount: await memberCountOf(db, vault.id),
  });
});

export const PATCH = guarded(async (event) => {
  const { vault, role } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const body = await parseBody(event, vaultUpdateRequestSchema);
  const db = createDb(requirePlatform(event).env.DB);

  const name = body.name ?? vault.name;
  let slug = vault.slug;
  if (body.slug !== undefined) {
    slug = slugify(body.slug);
    if (!slug) throw new HttpError(400, "could not derive a slug");
    const clash = await db
      .select({ id: schema.vault.id })
      .from(schema.vault)
      .where(
        and(
          eq(schema.vault.ownerId, vault.ownerId),
          eq(schema.vault.slug, slug),
          ne(schema.vault.id, vault.id),
        ),
      )
      .limit(1);
    if (clash.length > 0) throw new HttpError(409, `a vault with slug "${slug}" already exists`);
  }

  await db.update(schema.vault).set({ name, slug }).where(eq(schema.vault.id, vault.id));
  return json({
    id: vault.id,
    slug,
    name,
    createdAt: vault.createdAt.toISOString(),
    role,
    memberCount: await memberCountOf(db, vault.id),
  });
});

export const DELETE = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, {
    sessionOnly: true,
    role: "owner",
  });
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  // Destroy DO storage first, then the control-plane rows (keys, members, and
  // invites cascade with the vault row).
  await vaultClient(platform.env.VAULT_DO, vault.id).destroy();
  // OAuth grants anchored on this vault: multi-vault grants move to another
  // vault they cover; single/selected grants left with nothing are deleted;
  // an "all" grant left with nothing lives on (anchor → NULL).
  await prepareGrantsForVaultDelete(platform.env.DB, vault.id);
  await db.delete(schema.vault).where(eq(schema.vault.id, vault.id));
  return new Response(null, { status: 204 });
});
