/**
 * POST /api/support/replies — draft or send a reply on a support-inbox task
 * (SPEC-CLOUD "Support inbox"). Auth: a session member (editor+) of the
 * support vault, or a bz_ key of that vault. Keys can always draft but only
 * send when the auto-send policy allows the task's category. Deliberately a
 * REST endpoint, never an MCP tool (directory policy).
 */
import { json } from "@sveltejs/kit";
import { supportReplyRequestSchema } from "@brainz/contracts";
import { HttpError, guarded, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";
import { supportReply } from "$lib/server/support-reply";

export const POST = guarded(async (event) => {
  const { env } = requirePlatform(event);
  if (!env.SUPPORT_VAULT_ID) throw new HttpError(404, "support inbox not configured");
  const access = await requireVaultAccess(event, env.SUPPORT_VAULT_ID, { role: "editor" });
  const req = await parseBody(event, supportReplyRequestSchema);
  const result = await supportReply(
    env,
    vaultClient(env.VAULT_DO, access.vault.id),
    {
      via: access.via === "session" ? "session" : "key",
      label: access.via === "session" ? (event.locals.user?.email ?? "session user") : "api key",
    },
    req,
  );
  return json(result, { status: result.mode === "send" ? 201 : 200 });
});
