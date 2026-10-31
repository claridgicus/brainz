/**
 * Support inbox — the Worker's `email` handler (SPEC-CLOUD "Support inbox").
 *
 * Cloudflare Email Routing delivers mail for support@brownmatter.ai to this
 * Worker. adapter-cloudflare only emits `fetch`, so scripts/patch-worker.mjs
 * attaches `email` to the generated default export, as it does `scheduled`.
 * It lives on brainz-cloud (not a separate Worker) because it writes tasks
 * straight into the support vault's Durable Object and reads/writes D1, both
 * bound here already; a second Worker would need cross-script DO bindings and
 * a second deploy for no isolation gain.
 *
 * Order of operations, so mail that matters is never lost:
 *   size cap → parse → authentication + drop → classify → rate limits →
 *   forward (escalations, under an hourly cap) → store (D1 row, R2
 *   raw/attachments, task) → if storing failed and nothing was forwarded,
 *   forward as a fallback.
 *
 * Rejected and dropped mail leaves no D1 row (only a log line), so it can't
 * fill the inbox's hourly budget or keep data about spoofed senders.
 */
import type { R2Bucket } from "@cloudflare/workers-types";
import type { CloudEnv } from "../../app.d";
import type { D1Like } from "./dream-budget";
import { vaultClient, VaultDoError } from "./vault-client";
import {
  DEFAULT_ESCALATE_TO,
  ESCALATION_HOURLY_LIMIT,
  GLOBAL_HOURLY_LIMIT,
  MAX_D1_RAW_BYTES,
  MAX_INBOUND_BYTES,
  LEGAL_ESCALATION_HOURLY_LIMIT,
  REVIEWER_ESCALATION_HOURLY_LIMIT,
  RAW_RETENTION_DAYS,
  SENDER_HOURLY_LIMIT,
  type AttachmentMeta,
  type Classification,
  type ParsedInbound,
  type SectionOpts,
  classifyInbound,
  dropReason,
  inboundSection,
  escalationClass,
  type EscalationClass,
  newTaskBody,
  oneLine,
  parseAuthResults,
  parseInbound,
  senderAuthenticated,
  supportTaskId,
  taskTags,
} from "./support-inbox";

/** The slice of a ForwardableEmailMessage the handler uses. */
export interface InboundEmail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

/** The slice of the vault client the inbox writes through. */
export interface SupportVault {
  getConcept(id: string): Promise<{ concept: { id: string; title: string; body: string; tags: string[]; taskStatus?: string } | null }>;
  upsertConcept(input: {
    id: string;
    title: string;
    body: string;
    type: "task";
    tags: string[];
    taskStatus?: "open";
  }): Promise<unknown>;
  reopenTask(args: { id: string }): Promise<unknown>;
}

export type SupportEnv = Pick<CloudEnv, "SUPPORT_VAULT_ID" | "SUPPORT_ESCALATE_TO" | "SUPPORT_MAIL"> & {
  DB: D1Like;
};

export interface InboundOutcome {
  disposition: "task" | "escalated" | "dropped" | "rejected" | "stored";
  taskId: string | null;
  category: Classification["category"] | null;
  forwarded: boolean;
  note: string;
}

const HOUR_MS = 60 * 60 * 1000;

export function escalationAddress(env: Pick<SupportEnv, "SUPPORT_ESCALATE_TO">): string {
  return env.SUPPORT_ESCALATE_TO?.trim() || DEFAULT_ESCALATE_TO;
}

async function readRaw(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream as unknown as BodyInit).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function safeKeyPart(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "file";
}

async function countSince(db: D1Like, where: string, binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*) AS n FROM support_message WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Inbound rows of mail that was kept (rejected/dropped mail leaves no row). */
const KEPT_INBOUND = `direction = 'in' AND disposition IN ('task', 'escalated', 'stored')`;
/** SQL twin of escalationClass() over a row's category + auth_json. */
const REVIEWER_ROW = `coalesce(category, '') = 'reviewer'`;
const LEGAL_ROW = `(coalesce(category, '') = 'legal' AND coalesce(json_extract(auth_json, '$.authenticated'), 0) = 1)`;
const CLASS_ROW: Record<EscalationClass, string> = {
  reviewer: REVIEWER_ROW,
  legal: LEGAL_ROW,
  ordinary: `NOT (${REVIEWER_ROW} OR ${LEGAL_ROW})`,
};
const CLASS_LIMIT: Record<EscalationClass, number> = {
  reviewer: REVIEWER_ESCALATION_HOURLY_LIMIT,
  legal: LEGAL_ESCALATION_HOURLY_LIMIT,
  ordinary: ESCALATION_HOURLY_LIMIT,
};

/** Escalation forwards in the last hour drawing on one class's budget. */
async function forwardsSince(db: D1Like, since: number, cls: EscalationClass): Promise<number> {
  return countSince(db, `direction = 'in' AND disposition = 'escalated' AND created_at >= ? AND ${CLASS_ROW[cls]}`, [since]);
}

/**
 * The support task an inbound message belongs to: the task of a known message
 * its In-Reply-To/References name (ours or theirs), but only when the sender
 * is authenticated and is a participant of that thread (its original sender,
 * or someone we sent a reply to). Anyone else, including a sender who learnt
 * a Message-ID, opens a new task instead of joining someone else's thread.
 */
export async function findThreadTask(
  db: D1Like,
  threadIds: readonly string[],
  sender: string,
  authenticated: boolean,
): Promise<string | null> {
  if (!authenticated) return null;
  for (const id of threadIds.slice(0, 50)) {
    const row = await db
      .prepare(
        `SELECT task_id FROM support_message WHERE message_id = ? AND task_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(id)
      .first<{ task_id: string }>();
    if (row?.task_id && (await isThreadParticipant(db, row.task_id, sender))) return row.task_id;
  }
  return null;
}

async function isThreadParticipant(db: D1Like, taskId: string, sender: string): Promise<boolean> {
  const original = await db
    .prepare(
      `SELECT from_addr FROM support_message WHERE task_id = ? AND direction = 'in' ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    )
    .bind(taskId)
    .first<{ from_addr: string }>();
  if (original?.from_addr === sender) return true;
  const repliedTo = await db
    .prepare(
      `SELECT 1 AS ok FROM support_message WHERE task_id = ? AND direction = 'out' AND disposition = 'sent' AND to_addr = ? LIMIT 1`,
    )
    .bind(taskId, sender)
    .first<{ ok: number }>();
  return Boolean(repliedTo);
}

/** Daily retention (scheduled.ts): clear raw MIME kept in D1 after RAW_RETENTION_DAYS. */
export async function purgeSupportMail(db: D1Like, now: Date): Promise<void> {
  await db
    .prepare(`UPDATE support_message SET raw_b64 = NULL WHERE raw_b64 IS NOT NULL AND created_at < ?`)
    .bind(now.getTime() - RAW_RETENTION_DAYS * 24 * HOUR_MS)
    .run();
}

interface RowInput {
  id: string;
  msg: ParsedInbound | null;
  envelopeFrom: string;
  envelopeTo: string;
  taskId: string | null;
  category: string | null;
  disposition: InboundOutcome["disposition"];
  note: string;
  authJson: string | null;
  attachments: (AttachmentMeta & { key?: string })[];
  rawKey: string | null;
  rawB64: string | null;
  size: number;
  now: Date;
}

async function insertInboundRow(db: D1Like, r: RowInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO support_message (id, direction, message_id, task_id, from_addr, to_addr, reply_to, subject, category, disposition, note, auth_json, attachments_json, raw_key, raw_b64, size, created_at)
       VALUES (?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      r.id,
      r.msg?.messageId || null,
      r.taskId,
      r.msg?.from || r.envelopeFrom.toLowerCase(),
      r.envelopeTo.toLowerCase(),
      r.msg?.replyTo ?? null,
      oneLine(r.msg?.subject ?? "", 500),
      r.category,
      r.disposition,
      r.note,
      r.authJson,
      JSON.stringify(r.attachments),
      r.rawKey,
      r.rawB64,
      r.size,
      r.now.getTime(),
    )
    .run();
}

/** Create the thread's task, or append the message to it (reopening a done task). */
async function writeTask(
  vault: SupportVault,
  existingTaskId: string | null,
  msg: ParsedInbound,
  classification: Classification,
  now: Date,
  opts: SectionOpts,
): Promise<string> {
  if (existingTaskId) {
    const { concept } = await vault.getConcept(existingTaskId);
    if (concept) {
      await vault.upsertConcept({
        id: concept.id,
        title: concept.title,
        type: "task",
        body: `${concept.body.replace(/\n+$/, "")}\n\n${inboundSection(msg, classification, now, opts)}`,
        tags: taskTags(concept.tags, classification, opts.escalated),
      });
      if (concept.taskStatus === "done") await vault.reopenTask({ id: concept.id });
      return concept.id;
    }
  }
  const id = supportTaskId(msg.subject, msg.messageId, now);
  await vault.upsertConcept({
    id,
    title: oneLine(msg.subject || `Message from ${msg.from}`, 200),
    type: "task",
    taskStatus: "open",
    body: newTaskBody(msg, classification, now, opts),
    tags: taskTags([], classification, opts.escalated),
  });
  return id;
}

/**
 * Handle one inbound message. `vault` is null when SUPPORT_VAULT_ID is unset:
 * everything kept is then forwarded so nothing is lost before the inbox is
 * configured.
 */
export async function handleInbound(
  message: InboundEmail,
  env: SupportEnv,
  vault: SupportVault | null,
  now = new Date(),
): Promise<InboundOutcome> {
  const db = env.DB;
  const escalateTo = escalationAddress(env);
  const rowId = crypto.randomUUID();
  const base = { id: rowId, envelopeFrom: message.from, envelopeTo: message.to, now };
  let forwarded = false;
  const forward = async (category: string, note: string): Promise<void> => {
    if (forwarded) return;
    const headers = new Headers({ "X-Brainz-Support-Category": category });
    if (note) headers.set("X-Brainz-Support-Note", oneLine(note, 200));
    try {
      await message.forward(escalateTo, headers);
      forwarded = true;
    } catch (err) {
      console.error(`[support] forward to ${escalateTo} failed`, err);
    }
  };
  const record = async (r: Omit<RowInput, keyof typeof base>): Promise<boolean> => {
    try {
      await insertInboundRow(db, { ...base, ...r });
      return true;
    } catch (err) {
      console.error("[support] D1 insert failed", err);
      return false;
    }
  };
  const emptyRow = { taskId: null, authJson: null, attachments: [], rawKey: null, rawB64: null };
  const bucket: R2Bucket | undefined = env.SUPPORT_MAIL;
  const since = now.getTime() - HOUR_MS;
  /** Raw MIME to R2 when bound, else into D1 up to MAX_D1_RAW_BYTES. */
  const keepRaw = async (raw: Uint8Array): Promise<{ rawKey: string | null; rawB64: string | null }> => {
    if (bucket) {
      const rawKey = `support/${now.toISOString().slice(0, 10)}/${rowId}/raw.eml`;
      await bucket.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" } });
      return { rawKey, rawB64: null };
    }
    return { rawKey: null, rawB64: raw.byteLength <= MAX_D1_RAW_BYTES ? base64(raw) : null };
  };
  /** Room left under the hourly forward cap? A D1 outage allows the forward. */
  const mayForward = async (cls: EscalationClass): Promise<boolean> => {
    try {
      return (await forwardsSince(db, since, cls)) < CLASS_LIMIT[cls];
    } catch (err) {
      console.error("[support] forward-cap check failed; forwarding", err);
      return true;
    }
  };

  // 1. Size cap, before reading the stream.
  if (message.rawSize > MAX_INBOUND_BYTES) {
    const note = `message too large (${message.rawSize} bytes; limit ${MAX_INBOUND_BYTES})`;
    message.setReject(`Message too large: the limit is ${MAX_INBOUND_BYTES / 1024 / 1024} MB.`);
    console.log(`[support] rejected: ${note}`);
    return { disposition: "rejected", taskId: null, category: null, forwarded, note };
  }

  // 2. Parse. A message we can't parse goes to a human (under the ordinary
  // forward cap); its raw is kept so it survives a failed or capped forward.
  const raw = await readRaw(message.raw);
  let msg: ParsedInbound;
  try {
    msg = await parseInbound(raw, message.from);
  } catch (err) {
    console.error("[support] parse failed", err);
    if (await mayForward("ordinary")) await forward("unparsed", "could not parse");
    let kept: { rawKey: string | null; rawB64: string | null } = { rawKey: null, rawB64: null };
    try {
      kept = await keepRaw(raw);
    } catch (rawErr) {
      console.error("[support] R2 write failed", rawErr);
    }
    const note = forwarded ? "parse failed" : "parse failed; not forwarded";
    await record({ ...emptyRow, ...kept, msg: null, category: "unsure", disposition: forwarded ? "escalated" : "stored", note, size: raw.byteLength });
    return { disposition: forwarded ? "escalated" : "stored", taskId: null, category: "unsure", forwarded, note };
  }

  // 3. Authentication + spam: dropped silently (no bounce → no backscatter).
  const auth = parseAuthResults(msg.authResults);
  const authenticated = senderAuthenticated(msg.from, auth);
  const authJson = JSON.stringify({ ...auth, authenticated });
  const drop = dropReason(msg, auth);
  if (drop) {
    console.log(`[support] dropped: ${drop}`);
    return { disposition: "dropped", taskId: null, category: null, forwarded, note: drop };
  }

  const classification = classifyInbound(msg, auth);
  const cls: EscalationClass = classification.escalate
    ? escalationClass(classification.category, authenticated)
    : "ordinary";

  // 4. Rate limits (reject with a reason a real sender can read), counting only
  // kept mail. A D1 outage skips the limit rather than losing mail. Every
  // message is under the per-sender limit; authenticated reviewer and legal
  // escalations skip only the inbox-wide one.
  try {
    const fromSender = await countSince(db, `${KEPT_INBOUND} AND from_addr = ? AND created_at >= ?`, [msg.from, since]);
    const total = cls === "ordinary" ? await countSince(db, `${KEPT_INBOUND} AND created_at >= ?`, [since]) : 0;
    const limited =
      fromSender >= SENDER_HOURLY_LIMIT ? "sender" : total >= GLOBAL_HOURLY_LIMIT ? "inbox" : null;
    if (limited) {
      const note = `rate limited (${limited})`;
      message.setReject("Too many messages to this inbox; please try again later.");
      console.log(`[support] rejected: ${note}`);
      return { disposition: "rejected", taskId: null, category: classification.category, forwarded, note };
    }
  } catch (err) {
    console.error("[support] rate-limit check failed; continuing", err);
  }

  // 5. Escalate first, so storage trouble can't swallow it, unless this
  // class's hourly forward cap is spent: then it is kept as a task only, or
  // rejected when there is no vault to keep it in.
  let notForwarded: string | undefined;
  if (classification.escalate || !vault) {
    if (await mayForward(cls)) {
      await forward(classification.category, vault ? classification.reason : "support vault not configured");
    } else if (!vault) {
      const note = "forward cap reached and no support vault";
      message.setReject("Too many messages to this inbox; please try again later.");
      console.log(`[support] rejected: ${note}`);
      return { disposition: "rejected", taskId: null, category: classification.category, forwarded, note };
    } else {
      notForwarded = "hourly forward cap reached";
    }
  }

  // 6. Store: raw + attachments (R2 when bound), task, D1 row.
  let rawKey: string | null = null;
  let rawB64: string | null = null;
  const attachments: (AttachmentMeta & { key?: string })[] = msg.attachments.map((a) => ({ ...a }));
  let attachmentsStored = false;
  try {
    ({ rawKey, rawB64 } = await keepRaw(raw));
    if (bucket) {
      const prefix = `support/${now.toISOString().slice(0, 10)}/${rowId}`;
      for (let i = 0; i < attachments.length; i++) {
        const key = `${prefix}/att-${i}-${safeKeyPart(attachments[i].filename)}`;
        await bucket.put(key, msg.attachmentContents[i], { httpMetadata: { contentType: attachments[i].mimeType } });
        attachments[i].key = key;
      }
      attachmentsStored = attachments.length > 0;
    }
  } catch (err) {
    console.error("[support] R2 write failed", err);
  }

  // Auto-generated mail only joins an existing thread; it never opens a task.
  let taskId: string | null = null;
  let taskError: unknown = null;
  if (vault) {
    try {
      const existing = await findThreadTask(db, msg.threadIds, msg.from, authenticated);
      if (existing || classification.category !== "auto") {
        taskId = await writeTask(vault, existing, msg, classification, now, {
          escalated: forwarded,
          attachmentsStored,
          authenticated,
          notForwarded,
        });
      }
    } catch (err) {
      taskError = err;
      console.error(
        `[support] task write failed${err instanceof VaultDoError ? ` (${err.status})` : ""}`,
        err,
      );
    }
  }

  const disposition: InboundOutcome["disposition"] = forwarded ? "escalated" : taskId ? "task" : "stored";
  const note = notForwarded ? `${classification.reason}; ${notForwarded}` : classification.reason;
  const stored = await record({
    msg,
    authJson,
    taskId,
    category: classification.category,
    disposition,
    note,
    attachments,
    rawKey,
    rawB64,
    size: raw.byteLength,
  });

  // 7. Fallback: if the agent can't see it, a human must.
  if (!forwarded && (taskError || !stored) && classification.category !== "auto") {
    await forward(classification.category, "storage failed; forwarded as fallback");
  }

  return {
    disposition: forwarded ? "escalated" : disposition,
    taskId,
    category: classification.category,
    forwarded,
    note,
  };
}

/**
 * Entry point attached to the Worker's default export by patch-worker.mjs.
 * Must never throw: an exception makes Email Routing retry or bounce.
 */
export async function email(
  message: InboundEmail,
  env: CloudEnv,
  _ctx: unknown,
): Promise<void> {
  const vault = env.SUPPORT_VAULT_ID ? vaultClient(env.VAULT_DO, env.SUPPORT_VAULT_ID) : null;
  try {
    const outcome = await handleInbound(message, env as unknown as SupportEnv, vault);
    console.log(
      `[support] ${outcome.disposition} category=${outcome.category ?? "-"} task=${outcome.taskId ?? "-"} forwarded=${outcome.forwarded}`,
    );
  } catch (err) {
    console.error("[support] inbound handler failed; forwarding", err);
    try {
      await message.forward(escalationAddress(env), new Headers({ "X-Brainz-Support-Category": "error" }));
    } catch (fwdErr) {
      console.error("[support] fallback forward failed", fwdErr);
    }
  }
}
