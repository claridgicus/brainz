import { describe, expect, it } from "vitest";
import { fakeD1 } from "./fake-d1.testutil";
import { fakeVault, rawEmail } from "./support-fixtures.testutil";
import { handleInbound, type InboundEmail } from "./support-email";
import { SENDER_HOURLY_LIMIT } from "./support-inbox";

const PASS = "spf=pass; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";

function message(raw: string, opts: { from?: string; rawSize?: number } = {}) {
  const forwards: { to: string; headers?: Headers }[] = [];
  const rejects: string[] = [];
  const m: InboundEmail = {
    from: opts.from ?? "ada@example.com",
    to: "support@brownmatter.ai",
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    rawSize: opts.rawSize ?? raw.length,
    setReject: (r) => rejects.push(r),
    forward: async (to, headers) => {
      forwards.push({ to, headers });
      return {};
    },
  };
  return { m, forwards, rejects };
}

function setup() {
  const d1 = fakeD1();
  const vault = fakeVault();
  const env = { DB: d1, SUPPORT_VAULT_ID: "support" };
  const rows = () =>
    d1.db.prepare(`SELECT * FROM support_message ORDER BY created_at, rowid`).all() as Record<string, unknown>[];
  return { d1, vault, env, rows };
}

const at = (min: number) => new Date(Date.UTC(2026, 9, 29, 10, min));

describe("handleInbound", () => {
  it("creates a support task for a how-to question and does not forward it", async () => {
    const { vault, env, rows } = setup();
    const { m, forwards } = message(rawEmail({ auth: PASS }));
    const out = await handleInbound(m, env, vault, at(0));
    expect(out).toMatchObject({ disposition: "task", category: "howto", forwarded: false });
    const task = vault.concepts.get(out.taskId!)!;
    expect(task.title).toBe("How do I connect Claude Code?");
    expect(task.taskStatus).toBe("open");
    expect(task.tags.sort()).toEqual(["cat-howto", "inbox", "support"]);
    expect(task.body).toContain("ada@example.com");
    expect(forwards).toHaveLength(0);
    const [row] = rows();
    expect(row).toMatchObject({ direction: "in", message_id: "m1@example.com", task_id: out.taskId, disposition: "task" });
    expect(row.raw_b64).toBeTruthy(); // no R2 bound → raw kept in D1
  });

  it("threads a reply onto the same task by In-Reply-To / References", async () => {
    const { vault, env } = setup();
    const first = await handleInbound(message(rawEmail({ auth: PASS })).m, env, vault, at(0));
    vault.concepts.get(first.taskId!)!.taskStatus = "done";
    const reply = rawEmail({
      auth: PASS,
      subject: "Re: How do I connect Claude Code?",
      messageId: "m2@example.com",
      references: "<m1@example.com>",
      body: "Thanks, one more question on how to install it.",
    });
    const second = await handleInbound(message(reply).m, env, vault, at(5));
    expect(second.taskId).toBe(first.taskId);
    const task = vault.concepts.get(first.taskId!)!;
    expect(task.body.match(/## Message /g)).toHaveLength(2);
    expect(task.body).toContain("> Thanks, one more question");
    expect(task.taskStatus).toBe("open"); // reopened
    expect(vault.concepts.size).toBe(1);
  });

  it("forwards authenticated reviewer mail and tags it escalated", async () => {
    const { vault, env } = setup();
    const raw = rawEmail({
      from: "Reviewer <rev@anthropic.com>",
      subject: "Directory review",
      auth: "spf=pass; dkim=pass header.d=anthropic.com; dmarc=pass header.from=anthropic.com",
    });
    const { m, forwards } = message(raw, { from: "rev@anthropic.com" });
    const out = await handleInbound(m, env, vault, at(0));
    expect(out).toMatchObject({ disposition: "escalated", category: "reviewer", forwarded: true });
    expect(forwards).toHaveLength(1);
    expect(forwards[0].to).toBe("james@plutocracy.io");
    expect(forwards[0].headers?.get("X-Brainz-Support-Category")).toBe("reviewer");
    expect(vault.concepts.get(out.taskId!)!.tags).toContain("escalated");
  });

  it("honors SUPPORT_ESCALATE_TO", async () => {
    const { vault, env } = setup();
    const { m, forwards } = message(rawEmail({ auth: PASS, subject: "Delete my account", body: "please" }));
    await handleInbound(m, { ...env, SUPPORT_ESCALATE_TO: "ops@example.com" }, vault, at(0));
    expect(forwards.map((f) => f.to)).toEqual(["ops@example.com"]);
  });

  it("silently drops DMARC failures (no task, no forward, no bounce)", async () => {
    const { vault, env, rows } = setup();
    const { m, forwards, rejects } = message(rawEmail({ auth: "spf=fail; dkim=fail; dmarc=fail" }));
    const out = await handleInbound(m, env, vault, at(0));
    expect(out.disposition).toBe("dropped");
    expect(forwards).toHaveLength(0);
    expect(rejects).toHaveLength(0);
    expect(vault.concepts.size).toBe(0);
    expect(rows()[0]).toMatchObject({ disposition: "dropped", note: "DMARC fail", raw_b64: null });
  });

  it("rejects oversized mail before reading it", async () => {
    const { vault, env } = setup();
    const { m, rejects } = message(rawEmail({ auth: PASS }), { rawSize: 11 * 1024 * 1024 });
    const out = await handleInbound(m, env, vault, at(0));
    expect(out.disposition).toBe("rejected");
    expect(rejects[0]).toMatch(/too large/);
  });

  it("rate-limits a sender but never an escalation", async () => {
    const { vault, env } = setup();
    for (let i = 0; i < SENDER_HOURLY_LIMIT; i++) {
      const out = await handleInbound(message(rawEmail({ auth: PASS, messageId: `n${i}@x` })).m, env, vault, at(i));
      expect(out.disposition).toBe("task");
    }
    const limited = message(rawEmail({ auth: PASS, messageId: "over@x" }));
    expect((await handleInbound(limited.m, env, vault, at(30))).disposition).toBe("rejected");
    expect(limited.rejects[0]).toMatch(/Too many/);
    const legal = message(rawEmail({ auth: PASS, messageId: "legal@x", subject: "GDPR request" }));
    expect((await handleInbound(legal.m, env, vault, at(31))).disposition).toBe("escalated");
  });

  it("forwards everything when no support vault is configured", async () => {
    const { env } = setup();
    const { m, forwards } = message(rawEmail({ auth: PASS }));
    const out = await handleInbound(m, { DB: env.DB }, null, at(0));
    expect(out).toMatchObject({ forwarded: true, taskId: null });
    expect(forwards).toHaveLength(1);
  });

  it("forwards as a fallback when the task write fails", async () => {
    const { vault, env } = setup();
    vault.fail = true;
    const { m, forwards } = message(rawEmail({ auth: PASS }));
    const out = await handleInbound(m, env, vault, at(0));
    expect(out.forwarded).toBe(true);
    expect(forwards[0].headers?.get("X-Brainz-Support-Note")).toMatch(/fallback/);
  });

  it("stores auto-generated mail without opening a task", async () => {
    const { vault, env, rows } = setup();
    const raw = rawEmail({ auth: PASS, subject: "Out of office", body: "Away", extraHeaders: ["Auto-Submitted: auto-replied"] });
    const out = await handleInbound(message(raw).m, env, vault, at(0));
    expect(out).toMatchObject({ disposition: "stored", taskId: null, category: "auto" });
    expect(vault.concepts.size).toBe(0);
    expect(rows()).toHaveLength(1);
  });

  it("keeps attachment metadata on the row and the task", async () => {
    const { vault, env, rows } = setup();
    const raw = rawEmail({ auth: PASS, body: "How do I fix this? log attached", attachment: { filename: "log.txt", type: "text/plain", content: "boom" } });
    const out = await handleInbound(message(raw).m, env, vault, at(0));
    expect(JSON.parse(String(rows()[0].attachments_json))).toEqual([{ filename: "log.txt", mimeType: "text/plain", size: 4 }]);
    expect(vault.concepts.get(out.taskId!)!.body).toContain("log.txt (text/plain, 4 bytes)");
  });

  it("puts raw mail and attachments in R2 when SUPPORT_MAIL is bound", async () => {
    const { vault, env, rows } = setup();
    const puts: string[] = [];
    const bucket = { put: async (key: string) => void puts.push(key) };
    const raw = rawEmail({ auth: PASS, body: "How do I fix this?", attachment: { filename: "a b.png", type: "image/png", content: "png" } });
    await handleInbound(message(raw).m, { ...env, SUPPORT_MAIL: bucket as never }, vault, at(0));
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatch(/^support\/2026-10-29\/.+\/raw\.eml$/);
    expect(puts[1]).toMatch(/att-0-a_b\.png$/);
    expect(rows()[0]).toMatchObject({ raw_b64: null, raw_key: puts[0] });
  });
});
