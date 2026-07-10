/**
 * GET/PATCH/DELETE /api/vaults/:vaultId.
 * GET: session or vault-scoped bearer key. PATCH/DELETE: session only.
 * DELETE destroys the vault's DO storage and cascades api keys.
 */
import { json } from "@sveltejs/kit";
import { vaultUpdateRequestSchema } from "@brainz/contracts";
import { slugify } from "@brainz/engine";
import { and, eq, ne } from "drizzle-orm";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  return json({
    id: vault.id,
    slug: vault.slug,
    name: vault.name,
    createdAt: vault.createdAt.toISOString(),
  });
});

export const PATCH = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { sessionOnly: true });
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
  return json({ id: vault.id, slug, name, createdAt: vault.createdAt.toISOString() });
});

export const DELETE = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { sessionOnly: true });
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  // Destroy DO storage first, then the control-plane rows (keys cascade).
  await vaultClient(platform.env.VAULT_DO, vault.id).destroy();
  await db.delete(schema.vault).where(eq(schema.vault.id, vault.id));
  return new Response(null, { status: 204 });
});
