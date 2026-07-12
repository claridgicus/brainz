/**
 * GET/POST /api/vaults (session only).
 * GET lists vaults by MEMBERSHIP (Wave M) with the caller's role + a cheap
 * memberCount; POST creates a vault AND its creator's `owner` member row.
 */
import { json } from "@sveltejs/kit";
import { vaultCreateRequestSchema, type VaultRole } from "@brainz/contracts";
import { slugify } from "@brainz/engine";
import { and, count, eq, inArray } from "drizzle-orm";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { requireUser } from "$lib/server/vault-access";

function toWire(
  v: typeof schema.vault.$inferSelect,
  role: VaultRole,
  memberCount: number,
) {
  return {
    id: v.id,
    slug: v.slug,
    name: v.name,
    createdAt: v.createdAt.toISOString(),
    role,
    memberCount,
  };
}

export const GET = guarded(async (event) => {
  const user = requireUser(event);
  const db = createDb(requirePlatform(event).env.DB);
  // Membership is the access source of truth: every vault the user is a
  // member of, with THEIR role on it.
  const rows = await db
    .select({ vault: schema.vault, role: schema.vaultMember.role })
    .from(schema.vaultMember)
    .innerJoin(schema.vault, eq(schema.vaultMember.vaultId, schema.vault.id))
    .where(eq(schema.vaultMember.userId, user.id))
    .orderBy(schema.vault.createdAt);

  // One grouped count for all listed vaults (cheap; avoids N queries).
  const counts = new Map<string, number>();
  const ids = rows.map((r) => r.vault.id);
  if (ids.length > 0) {
    const grouped = await db
      .select({ vaultId: schema.vaultMember.vaultId, n: count() })
      .from(schema.vaultMember)
      .where(inArray(schema.vaultMember.vaultId, ids))
      .groupBy(schema.vaultMember.vaultId);
    for (const g of grouped) counts.set(g.vaultId, g.n);
  }

  return json({
    vaults: rows.map((r) => toWire(r.vault, r.role as VaultRole, counts.get(r.vault.id) ?? 1)),
  });
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
    onboardedAt: null,
    // New vaults start private; public access is opt-in via settings.
    publicEnabled: false,
    publicTokenHash: null,
    publicCreatedAt: null,
  };
  // Vault + creator's owner membership land atomically (one D1 batch).
  await db.batch([
    db.insert(schema.vault).values(vault),
    db.insert(schema.vaultMember).values({
      id: crypto.randomUUID(),
      vaultId: vault.id,
      userId: user.id,
      role: "owner",
      createdAt: vault.createdAt,
    }),
  ]);
  return json(toWire(vault, "owner", 1), { status: 201 });
});
