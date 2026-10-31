/**
 * Support inbox — outbound replies and drafts (SPEC-CLOUD "Support inbox").
 *
 * Backs POST /api/support/replies. A reply always goes to the thread's
 * original sender's From address (never Reply-To, never an address from the
 * mail body); the caller never picks the recipient. It is sent from
 * support@brownmatter.ai through the same `send_email` binding as the magic
 * links, threaded with In-Reply-To + References, and logged on the task.
 * Agents (bz_ keys) may only send when the auto-send policy allows the thread
 * (autoSendBlocker, decided from the server's support_message rows, never
 * from task tags); otherwise they save a draft, the escalation address gets
 * a notice, and a human approves it.
 */
import { createMimeMessage } from "mimetext";
import type { SendEmail } from "@cloudflare/workers-types";
import type { SupportReplyRequest, SupportReplyResponse } from "@brainz/contracts";
import type { D1Like } from "./dream-budget";
import { HttpError } from "./api-util";
import {
  DRAFT_NOTICE_HOURLY_LIMIT,
  OUTBOUND_HOURLY_LIMIT,
  SUPPORT_ADDRESS,
  SUPPORT_FROM_NAME,
  autoSendBlocker,
  quoteUntrusted,
  replySubject,
  type InboundRecord,
} from "./support-inbox";
import { escalationAddress } from "./support-email";

async function loadEmailMessageCtor(): Promise<
  new (from: string, to: string, raw: string) => unknown
> {
  // Lazy for the same reason as mailer.ts: `cloudflare:email` only exists in workerd.
  const mod = (await import("cloudflare:email")) as {
    EmailMessage: new (from: string, to: string, raw: string) => unknown;
  };
  return mod.EmailMessage;
}

export interface SupportTaskVault {
  getConcept(id: string): Promise<{
    concept: { id: string; title: string; body: string; tags: string[] } | null;
  }>;
  upsertConcept(input: { id: string; title: string; body: string; type: "task"; tags: string[] }): Promise<unknown>;
}

/** D1Like plus `all()`, which the thread lookup needs. */
export interface ReplyD1 {
  prepare(query: string): {
    bind(...values: unknown[]): ReturnType<ReturnType<D1Like["prepare"]>["bind"]> & {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

export interface ReplyEnv {
  DB: ReplyD1;
  SEND_EMAIL?: SendEmail;
  SUPPORT_AUTOSEND_CATEGORIES?: string;
  SUPPORT_ESCALATE_TO?: string;
}

export interface ReplyActor {
  via: "session" | "key";
  /** Logged on the task: the user's email, or "api key". */
  label: string;
}

/** Raw-MIME sender, injectable for tests. Returns false when nothing was delivered (dev). */
export type RawSender = (from: string, to: string, raw: string) => Promise<boolean>;

export function bindingSender(binding: SendEmail | undefined): RawSender {
  return async (from, to, raw) => {
    if (!binding) {
      console.error(`[support] no send_email binding; reply to ${to} logged, not delivered:\n${raw}`);
      return false;
    }
    const EmailMessage = await loadEmailMessageCtor();
    await binding.send(new EmailMessage(from, to, raw) as Parameters<SendEmail["send"]>[0]);
    return true;
  };
}

export interface ThreadInfo {
  /** The thread's original sender (From): the only address a reply goes to. */
  to: string;
  /** A Reply-To the sender asked for, when it differs (shown to humans, never used). */
  replyTo: string | null;
  /** The original sender was DMARC/DKIM-authenticated. */
  authenticated: boolean;
  subject: string;
  inReplyTo: string | undefined;
  references: string[];
  /** Every inbound message on the thread, as the server recorded it. */
  inbound: InboundRecord[];
}

interface InboundRow {
  from_addr: string;
  reply_to: string | null;
  subject: string;
  message_id: string | null;
  category: string | null;
  disposition: string;
  auth_json: string | null;
}

function rowAuthenticated(authJson: string | null): boolean {
  try {
    return (JSON.parse(authJson ?? "{}") as { authenticated?: unknown }).authenticated === true;
  } catch {
    return false;
  }
}

/** The reply target and policy inputs of a support thread, from its support_message rows. */
export async function threadInfo(db: ReplyD1, taskId: string, fallbackSubject: string): Promise<ThreadInfo> {
  const { results } = await db
    .prepare(
      `SELECT from_addr, reply_to, subject, message_id, category, disposition, auth_json FROM support_message
       WHERE task_id = ? AND direction = 'in' ORDER BY created_at ASC, rowid ASC LIMIT 500`,
    )
    .bind(taskId)
    .all<InboundRow>();
  const original = results[0];
  if (!original) throw new HttpError(409, "this task has no inbound message to reply to");
  const fromSender = results.filter((r) => r.from_addr === original.from_addr);
  const last = fromSender[fromSender.length - 1];
  const refs = await db
    .prepare(
      `SELECT group_concat(message_id, ' ') AS ids FROM (
         SELECT message_id FROM support_message
         WHERE task_id = ? AND direction IN ('in', 'out') AND message_id IS NOT NULL
         ORDER BY created_at ASC LIMIT 50)`,
    )
    .bind(taskId)
    .first<{ ids: string | null }>();
  return {
    to: original.from_addr,
    replyTo: results.find((r) => r.reply_to && r.reply_to !== original.from_addr)?.reply_to ?? null,
    authenticated: rowAuthenticated(original.auth_json),
    subject: replySubject(last.subject || fallbackSubject),
    inReplyTo: last.message_id ?? undefined,
    references: (refs?.ids ?? "").split(" ").filter(Boolean),
    inbound: results.map((r) => ({
      fromAddr: r.from_addr,
      replyTo: r.reply_to,
      category: r.category,
      disposition: r.disposition,
      authenticated: rowAuthenticated(r.auth_json),
    })),
  };
}

/** Build the threaded reply MIME. Exported for tests. */
export function buildReplyMime(args: {
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
}): string {
  const mime = createMimeMessage();
  mime.setSender({ name: SUPPORT_FROM_NAME, addr: SUPPORT_ADDRESS });
  mime.setRecipient(args.to);
  mime.setSubject(args.subject);
  mime.setHeader("Message-ID", `<${args.messageId}>`);
  if (args.inReplyTo) mime.setHeader("In-Reply-To", `<${args.inReplyTo}>`);
  if (args.references.length > 0) {
    mime.setHeader("References", args.references.map((id) => `<${id}>`).join(" "));
  }
  mime.addMessage({ contentType: "text/plain", data: args.text });
  return mime.asRaw();
}

function appendSection(body: string, section: string): string {
  return `${body.replace(/\n+$/, "")}\n\n${section}\n`;
}

function newMessageId(): string {
  return `${crypto.randomUUID()}@brownmatter.ai`;
}

/** Draft or send a reply on a support task. */
export async function supportReply(
  env: ReplyEnv,
  vault: SupportTaskVault,
  actor: ReplyActor,
  req: SupportReplyRequest,
  send: RawSender = bindingSender(env.SEND_EMAIL),
  now = new Date(),
): Promise<SupportReplyResponse> {
  const db = env.DB;
  const { concept } = await vault.getConcept(req.taskId);
  if (!concept || !concept.tags.includes("support")) throw new HttpError(404, "support task not found");
  const thread = await threadInfo(db, concept.id, concept.title);
  const at = now.toISOString();

  if (req.mode === "draft") {
    const text = req.text!;
    await db
      .prepare(
        `INSERT INTO support_message (id, direction, task_id, from_addr, to_addr, subject, disposition, body_text, actor, size, created_at)
         VALUES (?, 'draft', ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), concept.id, SUPPORT_ADDRESS, thread.to, thread.subject, text, actor.label, text.length, now.getTime())
      .run();
    await vault.upsertConcept({
      id: concept.id,
      title: concept.title,
      type: "task",
      tags: [...new Set([...concept.tags, "draft"])],
      body: appendSection(
        concept.body,
        `## Draft reply ${at} by ${actor.label} (to ${thread.to}, awaiting approval)\n\n${quoteUntrusted(text)}`,
      ),
    });
    const draftsLastHour = await db
      .prepare(`SELECT count(*) AS n FROM support_message WHERE direction = 'draft' AND created_at >= ?`)
      .bind(now.getTime() - 60 * 60 * 1000)
      .first<{ n: number }>();
    if (Number(draftsLastHour?.n ?? 0) <= DRAFT_NOTICE_HOURLY_LIMIT) {
      await notifyDraft(env, send, { taskId: concept.id, subject: thread.subject, to: thread.to, text, actor });
    } else {
      console.log(`[support] draft notice for ${concept.id} skipped: hourly notice cap reached`);
    }
    return { taskId: concept.id, mode: "draft", to: thread.to, subject: thread.subject, inReplyTo: thread.inReplyTo, delivered: false, at };
  }

  // mode: send
  if (actor.via === "key") {
    const blocked = autoSendBlocker(thread.inbound, env.SUPPORT_AUTOSEND_CATEGORIES);
    if (blocked) {
      throw new HttpError(403, `an agent may not send on this thread (${blocked}); save a draft with mode: "draft" for approval`);
    }
  }
  let text = req.text;
  if (req.fromDraft) {
    const draft = await db
      .prepare(
        `SELECT body_text FROM support_message WHERE task_id = ? AND direction = 'draft' AND disposition = 'draft'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(concept.id)
      .first<{ body_text: string }>();
    if (!draft) throw new HttpError(409, "this task has no pending draft");
    text = draft.body_text;
  }
  const sentLastHour = await db
    .prepare(`SELECT count(*) AS n FROM support_message WHERE direction = 'out' AND disposition = 'sent' AND created_at >= ?`)
    .bind(now.getTime() - 60 * 60 * 1000)
    .first<{ n: number }>();
  if (Number(sentLastHour?.n ?? 0) >= OUTBOUND_HOURLY_LIMIT) {
    throw new HttpError(429, "outbound reply limit reached; try again later");
  }

  const messageId = newMessageId();
  const raw = buildReplyMime({ to: thread.to, subject: thread.subject, text: text!, messageId, inReplyTo: thread.inReplyTo, references: thread.references });
  let delivered: boolean;
  try {
    delivered = await send(SUPPORT_ADDRESS, thread.to, raw);
  } catch (err) {
    console.error(`[support] reply send to ${thread.to} failed`, err);
    await db
      .prepare(
        `INSERT INTO support_message (id, direction, message_id, task_id, from_addr, to_addr, subject, disposition, note, body_text, actor, size, created_at)
         VALUES (?, 'out', ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), messageId, concept.id, SUPPORT_ADDRESS, thread.to, thread.subject, String(err instanceof Error ? err.message : err).slice(0, 500), text!, actor.label, raw.length, now.getTime())
      .run();
    throw new HttpError(502, "the reply could not be sent");
  }
  await db
    .prepare(
      `INSERT INTO support_message (id, direction, message_id, task_id, from_addr, to_addr, subject, disposition, note, body_text, actor, size, created_at)
       VALUES (?, 'out', ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), messageId, concept.id, SUPPORT_ADDRESS, thread.to, thread.subject, delivered ? null : "dev: not delivered", text!, actor.label, raw.length, now.getTime())
    .run();
  // A send settles every pending draft on the thread (approved as-is or superseded).
  await db
    .prepare(`UPDATE support_message SET disposition = 'sent' WHERE task_id = ? AND direction = 'draft' AND disposition = 'draft'`)
    .bind(concept.id)
    .run();
  await vault.upsertConcept({
    id: concept.id,
    title: concept.title,
    type: "task",
    tags: concept.tags.filter((t) => t !== "draft"),
    body: appendSection(
      concept.body,
      `## Reply sent ${at} by ${actor.label} to ${thread.to}${delivered ? "" : " (dev: not delivered)"}\n\n_Message-ID <${messageId}>_\n\n${quoteUntrusted(text!)}`,
    ),
  });
  return { taskId: concept.id, mode: "send", to: thread.to, subject: thread.subject, messageId, inReplyTo: thread.inReplyTo, delivered, at };
}

/** Tell the escalation address a draft is waiting. Best effort: never fails the draft. */
async function notifyDraft(
  env: ReplyEnv,
  send: RawSender,
  d: { taskId: string; subject: string; to: string; text: string; actor: ReplyActor },
): Promise<void> {
  try {
    const mime = createMimeMessage();
    mime.setSender({ name: SUPPORT_FROM_NAME, addr: SUPPORT_ADDRESS });
    mime.setRecipient(escalationAddress(env));
    mime.setSubject(`Draft reply waiting: ${d.subject}`);
    mime.addMessage({
      contentType: "text/plain",
      data: [
        `${d.actor.label} drafted a reply to ${d.to} on support task ${d.taskId}.`,
        "",
        "Approve it at https://brainz.brownmatter.ai/support (or send your own).",
        "",
        "----- draft -----",
        d.text,
      ].join("\n"),
    });
    await send(SUPPORT_ADDRESS, escalationAddress(env), mime.asRaw());
  } catch (err) {
    console.error("[support] draft notice failed", err);
  }
}
