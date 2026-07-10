/** DELETE /api/keys/:keyId — revoke an API key (session only, owner only). */
import { eq } from "drizzle-orm";
import { guarded, HttpError, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { requireUser } from "$lib/server/vault-access";

export const DELETE = guarded(async (event) => {
  const user = requireUser(event);
  const db = createDb(requirePlatform(event).env.DB);
  const rows = await db
    .select({ key: schema.apiKey, ownerId: schema.vault.ownerId })
    .from(schema.apiKey)
    .innerJoin(schema.vault, eq(schema.apiKey.vaultId, schema.vault.id))
    .where(eq(schema.apiKey.id, event.params.keyId!))
    .limit(1);
  if (rows.length === 0 || rows[0].ownerId !== user.id) {
    throw new HttpError(404, "key not found");
  }
  await db.delete(schema.apiKey).where(eq(schema.apiKey.id, rows[0].key.id));
  return new Response(null, { status: 204 });
});
