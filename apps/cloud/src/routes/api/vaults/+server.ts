/** GET/POST /api/vaults — the caller's vault list (session only). */
import { json } from "@sveltejs/kit";
import { vaultCreateRequestSchema } from "@brainz/contracts";
import { slugify } from "@brainz/engine";
import { and, eq } from "drizzle-orm";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { requireUser } from "$lib/server/vault-access";

function toWire(v: typeof schema.vault.$inferSelect) {
  return {
    id: v.id,
    slug: v.slug,
    name: v.name,
    createdAt: v.createdAt.toISOString(),
  };
}

export const GET = guarded(async (event) => {
  const user = requireUser(event);
  const db = createDb(requirePlatform(event).env.DB);
  const vaults = await db
    .select()
    .from(schema.vault)
    .where(eq(schema.vault.ownerId, user.id))
    .orderBy(schema.vault.createdAt);
  return json({ vaults: vaults.map(toWire) });
});

export const POST = guarded(async (event) => {
  const user = requireUser(event);
  const body = await parseBody(event, vaultCreateRequestSchema);
  const slug = slugify(body.slug ?? body.name);
  if (!slug) throw new HttpError(400, "could not derive a slug");

  const db = createDb(requirePlatform(event).env.DB);
  const existing = await db
    .select({ id: schema.vault.id })
    .from(schema.vault)
    .where(and(eq(schema.vault.ownerId, user.id), eq(schema.vault.slug, slug)))
    .limit(1);
  if (existing.length > 0) throw new HttpError(409, `a vault with slug "${slug}" already exists`);

  const vault: typeof schema.vault.$inferSelect = {
    id: crypto.randomUUID(),
    ownerId: user.id,
    slug,
    name: body.name,
    createdAt: new Date(),
  };
  await db.insert(schema.vault).values(vault);
  return json(toWire(vault), { status: 201 });
});
