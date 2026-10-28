/**
 * Vault creation, shared by `POST /api/vaults` and the OAuth consent page's
 * "+ New vault" action (SPEC-CLOUD.md "Multi-vault grants"): the same slug
 * rules (slugify the slug or the name, unique per owner) and the same atomic
 * insert of the vault plus its creator's `owner` membership.
 */
import type { vaultCreateRequestSchema } from "@brainz/contracts";
import { slugify } from "@brainz/engine";
import { and, eq } from "drizzle-orm";
import { HttpError } from "./api-util";
import type { z } from "zod";
import { schema, type Db } from "./db";

type VaultCreateRequest = z.infer<typeof vaultCreateRequestSchema>;

export type VaultRow = typeof schema.vault.$inferSelect;

/** Create a vault owned by `ownerId`. Throws HttpError 400 (no slug) or 409 (slug taken). */
export async function createVault(db: Db, ownerId: string, body: VaultCreateRequest): Promise<VaultRow> {
  const slug = slugify(body.slug ?? body.name);
  if (!slug) throw new HttpError(400, "could not derive a slug");

  const existing = await db
    .select({ id: schema.vault.id })
    .from(schema.vault)
    .where(and(eq(schema.vault.ownerId, ownerId), eq(schema.vault.slug, slug)))
    .limit(1);
  if (existing.length > 0) throw new HttpError(409, `a vault with slug "${slug}" already exists`);

  const vault: VaultRow = {
    id: crypto.randomUUID(),
    ownerId,
    slug,
    name: body.name,
    createdAt: new Date(),
    onboardedAt: null,
    lastSyncedAt: null,
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
      userId: ownerId,
      role: "owner",
      createdAt: vault.createdAt,
    }),
  ]);
  return vault;
}
