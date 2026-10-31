import { describe, expect, it } from "vitest";
import { supportReplyRequestSchema, supportReplyResponseSchema } from "@brainz/contracts";
import { fakeD1 } from "./fake-d1.testutil";
import { fakeVault, rawEmail } from "./support-fixtures.testutil";
import { handleInbound, type InboundEmail } from "./support-email";
import { buildReplyMime, supportReply, type RawSender } from "./support-reply";
import { DRAFT_NOTICE_HOURLY_LIMIT, OUTBOUND_HOURLY_LIMIT, parseInbound } from "./support-inbox";
import { HttpError } from "./api-util";

const PASS = "spf=pass; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";
const at = (min: number) => new Date(Date.UTC(2026, 9, 29, 10, min));

function inbound(raw: string): InboundEmail {
  return {
    from: "ada@example.com",
    to: "support@brownmatter.ai",
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    rawSize: raw.length,
    setReject: () => {},
    forward: async () => ({}),
  };
}

async function setup(opts: { raw?: string; autosend?: string } = {}) {
  const d1 = fakeD1();
  const vault = fakeVault();
  const env = { DB: d1, SUPPORT_VAULT_ID: "support", SUPPORT_AUTOSEND_CATEGORIES: opts.autosend };
  const out = await handleInbound(inbound(opts.raw ?? rawEmail({ auth: PASS })), env, vault, at(0));
  const sent: { from: string; to: string; raw: string }[] = [];
  const send: RawSender = async (from, to, raw) => {
    sent.push({ from, to, raw });
    return true;
  };
  return { d1, vault, env, taskId: out.taskId!, sent, send };
}

const james = { via: "session" as const, label: "james@plutocracy.io" };
const agent = { via: "key" as const, label: "api key" };
const req = (r: unknown) => supportReplyRequestSchema.parse(r);

async function expectHttp(p: Promise<unknown>, status: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
}

describe("supportReply — drafts", () => {
  it("logs a draft on the task, tags it and notifies the escalation address", async () => {
    const { d1, vault, env, taskId, sent, send } = await setup();
    const res = await supportReply(env, vault, agent, req({ taskId, text: "Run `brainz init`." }), send, at(1));
    expect(supportReplyResponseSchema.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ mode: "draft", to: "ada@example.com", subject: "Re: How do I connect Claude Code?", delivered: false });
    const task = vault.concepts.get(taskId)!;
    expect(task.tags).toContain("draft");
    expect(task.body).toContain("## Draft reply 2026-10-29T10:01:00.000Z by api key");
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("james@plutocracy.io");
    const notice = await parseInbound(sent[0].raw);
    expect(notice.subject).toBe("Draft reply waiting: Re: How do I connect Claude Code?");
    expect(notice.text).toContain("Run `brainz init`.");
    const row = d1.db.prepare(`SELECT * FROM support_message WHERE direction = 'draft'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ disposition: "draft", body_text: "Run `brainz init`.", task_id: taskId });
  });
});

describe("supportReply — draft notices", () => {
  it("caps the draft notices sent to the escalation address", async () => {
    const { vault, env, taskId, sent, send } = await setup();
    for (let i = 0; i < DRAFT_NOTICE_HOURLY_LIMIT + 5; i++) {
      await supportReply(env, vault, agent, req({ taskId, text: `d${i}` }), send, at(1));
    }
    expect(sent).toHaveLength(DRAFT_NOTICE_HOURLY_LIMIT);
  });
});

describe("supportReply — sending", () => {
  it("refuses an agent send while auto-send is off (the default)", async () => {
    const { vault, env, taskId, send } = await setup();
    await expectHttp(supportReply(env, vault, agent, req({ taskId, text: "x", mode: "send" }), send), 403);
  });

  it("lets an agent send on a how-to task once auto-send enables howto", async () => {
    const { vault, env, taskId, sent, send } = await setup({ autosend: "howto" });
    const res = await supportReply(env, vault, agent, req({ taskId, text: "See the docs.", mode: "send" }), send, at(1));
    expect(res.mode).toBe("send");
    expect(sent).toHaveLength(1);
  });

  it("never lets an agent send on an escalated thread", async () => {
    const { vault, env, taskId, send } = await setup({
      autosend: "howto",
      raw: rawEmail({ auth: PASS, subject: "Hello", body: "Quick question about pricing." }),
    });
    await expectHttp(supportReply(env, vault, agent, req({ taskId, text: "x", mode: "send" }), send), 403);
  });

  it("sends a threaded reply from support@ to the sender and logs it on the task", async () => {
    const { d1, vault, env, taskId, sent, send } = await setup({
      raw: rawEmail({ auth: PASS, references: "<root@example.com>", inReplyTo: "root@example.com" }),
    });
    const res = await supportReply(env, vault, james, req({ taskId, text: "Hi Ada — see brownmatter.ai/docs.", mode: "send" }), send, at(2));
    expect(supportReplyResponseSchema.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ to: "ada@example.com", inReplyTo: "m1@example.com", delivered: true });
    expect(sent[0].from).toBe("support@brownmatter.ai");
    const parsed = await parseInbound(sent[0].raw);
    expect(parsed.from).toBe("support@brownmatter.ai");
    expect(parsed.subject).toBe("Re: How do I connect Claude Code?");
    expect(parsed.messageId).toBe(res.messageId);
    expect(parsed.threadIds).toContain("m1@example.com");
    const task = vault.concepts.get(taskId)!;
    expect(task.body).toContain(`## Reply sent 2026-10-29T10:02:00.000Z by james@plutocracy.io to ada@example.com`);
    const out = d1.db.prepare(`SELECT * FROM support_message WHERE direction = 'out'`).get() as Record<string, unknown>;
    expect(out).toMatchObject({ disposition: "sent", message_id: res.messageId, task_id: taskId });
  });

  it("threads the customer's answer to our reply back onto the task", async () => {
    const { vault, env, taskId, send } = await setup();
    const res = await supportReply(env, vault, james, req({ taskId, text: "Try this.", mode: "send" }), send, at(2));
    const answer = rawEmail({ auth: PASS, subject: "Re: How do I connect Claude Code?", messageId: "m3@example.com", inReplyTo: res.messageId, body: "That worked, thanks!" });
    const out = await handleInbound(inbound(answer), env, vault, at(3));
    expect(out.taskId).toBe(taskId);
  });

  it("replies to the authenticated From, never to a Reply-To, and never lets an agent send there", async () => {
    const { vault, env, taskId, send } = await setup({
      autosend: "howto",
      raw: rawEmail({ auth: PASS, extraHeaders: ["Reply-To: team@evil.example"] }),
    });
    await expectHttp(supportReply(env, vault, agent, req({ taskId, text: "x", mode: "send" }), send), 403);
    const res = await supportReply(env, vault, james, req({ taskId, text: "Hi", mode: "send" }), send);
    expect(res.to).toBe("ada@example.com");
  });

  it("never lets an agent send to an unauthenticated sender", async () => {
    const { vault, env, taskId, send } = await setup({
      autosend: "howto",
      raw: rawEmail({ auth: "spf=pass; dkim=none; dmarc=none" }),
    });
    await expectHttp(supportReply(env, vault, agent, req({ taskId, text: "x", mode: "send" }), send), 403);
    // A human still can, after seeing the warning on /support.
    expect((await supportReply(env, vault, james, req({ taskId, text: "Hi", mode: "send" }), send)).to).toBe("ada@example.com");
  });

  it("ignores task tags the agent rewrote: policy comes from the server's rows", async () => {
    const { vault, env, taskId, send } = await setup({
      autosend: "howto",
      raw: rawEmail({ auth: PASS, subject: "Hello", body: "Quick question about pricing." }),
    });
    const task = vault.concepts.get(taskId)!;
    expect(task.tags).toContain("escalated");
    // The agent's bz_ key can upsert the task with any tags.
    await vault.upsertConcept({ id: task.id, title: task.title, body: task.body, type: "task", tags: ["support", "inbox", "cat-howto"] });
    await expectHttp(supportReply(env, vault, agent, req({ taskId, text: "x", mode: "send" }), send), 403);
  });

  it("pins the recipient to the thread's original sender", async () => {
    const { d1, vault, env, taskId, send } = await setup();
    // Even if another sender's row ended up on the thread, replies go to the original.
    d1.db
      .prepare(
        `INSERT INTO support_message (id, direction, message_id, task_id, from_addr, to_addr, subject, disposition, auth_json, created_at)
         VALUES ('x', 'in', 'x@evil.example', ?, 'mallory@evil.example', 'support@brownmatter.ai', 'Re: x', 'task', '{"authenticated":true}', ?)`,
      )
      .run(taskId, at(5).getTime());
    const res = await supportReply(env, vault, james, req({ taskId, text: "Hi", mode: "send" }), send, at(6));
    expect(res.to).toBe("ada@example.com");
    expect(res.inReplyTo).toBe("m1@example.com");
  });

  it("approves the latest draft with fromDraft and clears the draft tag", async () => {
    const { d1, vault, env, taskId, sent, send } = await setup();
    await supportReply(env, vault, agent, req({ taskId, text: "Draft one" }), send, at(1));
    await supportReply(env, vault, agent, req({ taskId, text: "Draft two" }), send, at(2));
    await supportReply(env, vault, james, req({ taskId, mode: "send", fromDraft: true }), send, at(3));
    expect(sent.at(-1)!.raw).toContain("Draft two");
    expect(vault.concepts.get(taskId)!.tags).not.toContain("draft");
    const pending = d1.db.prepare(`SELECT count(*) AS n FROM support_message WHERE disposition = 'draft'`).get() as { n: number };
    expect(pending.n).toBe(0);
    await expectHttp(supportReply(env, vault, james, req({ taskId, mode: "send", fromDraft: true }), send), 409);
  });

  it("logs a failed send and returns 502 without logging it on the task", async () => {
    const { d1, vault, env, taskId } = await setup();
    const failing: RawSender = async () => {
      throw new Error("domain not onboarded");
    };
    await expectHttp(supportReply(env, vault, james, req({ taskId, text: "Hi", mode: "send" }), failing), 502);
    expect(vault.concepts.get(taskId)!.body).not.toContain("Reply sent");
    const row = d1.db.prepare(`SELECT disposition, note FROM support_message WHERE direction = 'out'`).get();
    expect(row).toEqual({ disposition: "failed", note: "domain not onboarded" });
  });

  it("caps outbound replies per hour", async () => {
    const { vault, env, taskId, send } = await setup();
    for (let i = 0; i < OUTBOUND_HOURLY_LIMIT; i++) {
      await supportReply(env, vault, james, req({ taskId, text: `r${i}`, mode: "send" }), send, at(1));
    }
    await expectHttp(supportReply(env, vault, james, req({ taskId, text: "one more", mode: "send" }), send, at(2)), 429);
  });

  it("404s for a task outside the support inbox", async () => {
    const { vault, env, send } = await setup();
    await expectHttp(supportReply(env, vault, james, req({ taskId: "nope", text: "x" }), send), 404);
  });
});

describe("contract", () => {
  it("requires text unless sending fromDraft", () => {
    expect(supportReplyRequestSchema.safeParse({ taskId: "t" }).success).toBe(false);
    expect(supportReplyRequestSchema.safeParse({ taskId: "t", fromDraft: true }).success).toBe(false);
    expect(supportReplyRequestSchema.safeParse({ taskId: "t", mode: "send", fromDraft: true }).success).toBe(true);
    expect(supportReplyRequestSchema.parse({ taskId: "t", text: "x" }).mode).toBe("draft");
  });
});

describe("buildReplyMime", () => {
  it("sets Message-ID, In-Reply-To and References", () => {
    const raw = buildReplyMime({ to: "a@b.c", subject: "Re: x", text: "hi", messageId: "id1@brownmatter.ai", inReplyTo: "p@x", references: ["r@x", "p@x"] });
    expect(raw).toContain("Message-ID: <id1@brownmatter.ai>");
    expect(raw).toContain("In-Reply-To: <p@x>");
    expect(raw).toContain("References: <r@x> <p@x>");
  });
});
