/**
 * GET/POST /api/vaults/:vaultId/keys — session only (keys can't mint keys).
 * POST is the ONLY place the plaintext `bz_` key ever appears.
 */
import { json } from "@sveltejs/kit";
import { apiKeyCreateRequestSchema } from "@brainz/contracts";
import { eq } from "drizzle-orm";
import { generateApiKey, hashApiKey, keyPrefixOf } from "$lib/server/api-keys";
import { guarded, parseBody, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { requireVaultAccess } from "$lib/server/vault-access";

function toWire(k: typeof schema.apiKey.$inferSelect) {
  return {
    id: k.id,
    vaultId: k.vaultId,
    name: k.name,
    keyPrefix: k.keyPrefix,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
  };
}

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { sessionOnly: true });
  const db = createDb(requirePlatform(event).env.DB);
  const keys = await db
    .select()
    .from(schema.apiKey)
    .where(eq(schema.apiKey.vaultId, vault.id))
    .orderBy(schema.apiKey.createdAt);
  return json({ keys: keys.map(toWire) });
});

export const POST = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { sessionOnly: true });
  const body = await parseBody(event, apiKeyCreateRequestSchema);
  const db = createDb(requirePlatform(event).env.DB);

  const key = generateApiKey();
  const row: typeof schema.apiKey.$inferSelect = {
    id: crypto.randomUUID(),
    vaultId: vault.id,
    name: body.name,
    keyHash: await hashApiKey(key),
    keyPrefix: keyPrefixOf(key),
    createdAt: new Date(),
    lastUsedAt: null,
  };
  await db.insert(schema.apiKey).values(row);
  return json({ ...toWire(row), key }, { status: 201 });
});
