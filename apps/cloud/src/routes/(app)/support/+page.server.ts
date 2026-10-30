/**
 * /support — approve agent drafts on the support inbox (SPEC-CLOUD "Support
 * inbox"). Visible to editor+ members of the support vault; everyone else
 * gets a 404. Sending goes through the same supportReply() as
 * POST /api/support/replies, as a session (human) send.
 */
import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { createDb } from "$lib/server/db";
import { HttpError } from "$lib/server/api-util";
import { memberRole, roleSatisfies } from "$lib/server/vault-access";
import { vaultClient } from "$lib/server/vault-client";
import { supportReply } from "$lib/server/support-reply";

async function requireSupportEditor(event: RequestEvent) {
  const env = event.platform?.env;
  const user = event.locals.user;
  if (!env?.SUPPORT_VAULT_ID || !user) error(404, "Not found");
  const role = await memberRole(createDb(env.DB), env.SUPPORT_VAULT_ID, user.id);
  if (!role || !roleSatisfies(role, "editor")) error(404, "Not found");
  return { env, user, vaultId: env.SUPPORT_VAULT_ID };
}

interface DraftRow {
  task_id: string;
  to_addr: string;
  subject: string;
  body_text: string;
  actor: string | null;
  created_at: number;
}

export const load: PageServerLoad = async (event) => {
  const { env } = await requireSupportEditor(event);
  // Latest pending draft per task.
  const { results } = await env.DB.prepare(
    `SELECT d.task_id, d.to_addr, d.subject, d.body_text, d.actor, d.created_at
     FROM support_message d
     WHERE d.direction = 'draft' AND d.disposition = 'draft'
       AND d.created_at = (SELECT max(created_at) FROM support_message x
                           WHERE x.task_id = d.task_id AND x.direction = 'draft' AND x.disposition = 'draft')
     ORDER BY d.created_at DESC LIMIT 100`,
  ).all<DraftRow>();
  return {
    drafts: results.map((r) => ({
      taskId: r.task_id,
      to: r.to_addr,
      subject: r.subject,
      text: r.body_text,
      actor: r.actor ?? "",
      at: new Date(r.created_at).toISOString(),
    })),
  };
};

export const actions: Actions = {
  send: async (event) => {
    const { env, user, vaultId } = await requireSupportEditor(event);
    const form = await event.request.formData();
    const taskId = String(form.get("taskId") ?? "");
    const text = String(form.get("text") ?? "").trim();
    if (!taskId || !text) return fail(400, { taskId, error: "Reply text is required." });
    try {
      const sent = await supportReply(
        env,
        vaultClient(env.VAULT_DO, vaultId),
        { via: "session", label: user.email },
        { taskId, text: text.slice(0, 20_000), mode: "send" },
      );
      return { sent: { taskId, to: sent.to, delivered: sent.delivered } };
    } catch (err) {
      const message = err instanceof HttpError ? err.message : "Sending failed.";
      return fail(err instanceof HttpError ? err.status : 500, { taskId, error: message });
    }
  },
};
