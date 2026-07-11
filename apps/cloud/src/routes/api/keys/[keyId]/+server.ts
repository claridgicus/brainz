/**
 * DELETE /api/keys/:keyId — revoke an API key (session only; Wave M: the
 * caller must hold the OWNER role on the key's vault — key management is
 * owner-only). Non-members and non-owners both get 404: a key id is opaque,
 * so distinguishing "exists but not yours" would leak tenancy.
 */
import { eq } from "drizzle-orm";
import { guarded, HttpError, requirePlatform } from "$lib/server/api-util";
import { createDb, schema } from "$lib/server/db";
import { memberRole, requireUser } from "$lib/server/vault-access";

export const DELETE = guarded(async (event) => {
  const user = requireUser(event);
  const db = createDb(requirePlatform(event).env.DB);
  const rows = await db
    .select({ key: schema.apiKey })
    .from(schema.apiKey)
    .where(eq(schema.apiKey.id, event.params.keyId!))
    .limit(1);
  if (rows.length === 0 || (await memberRole(db, rows[0].key.vaultId, user.id)) !== "owner") {
    throw new HttpError(404, "key not found");
  }
  await db.delete(schema.apiKey).where(eq(schema.apiKey.id, rows[0].key.id));
  return new Response(null, { status: 204 });
});
