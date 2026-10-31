import { describe, expect, it } from "vitest";
import { fakeD1 } from "./fake-d1.testutil";
import { fakeVault, rawEmail, unparseableEmail } from "./support-fixtures.testutil";
import { handleInbound, purgeSupportMail, type InboundEmail } from "./support-email";
import {
  ESCALATION_HOURLY_LIMIT,
  GLOBAL_HOURLY_LIMIT,
  LEGAL_ESCALATION_HOURLY_LIMIT,
  SENDER_HOURLY_LIMIT,
} from "./support-inbox";

const PASS = "spf=pass; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";

function message(raw: string, opts: { from?: string; rawSize?: number; forwardFails?: boolean } = {}) {
  const forwards: { to: string; headers?: Headers }[] = [];
  const rejects: string[] = [];
  const m: InboundEmail = {
    from: opts.from ?? "ada@example.com",
    to: "support@brownmatter.ai",
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    rawSize: opts.rawSize ?? raw.length,
    setReject: (r) => rejects.push(r),
    forward: async (to, headers) => {
      if (opts.forwardFails) throw new Error("destination not verified");
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

/** Seed `n` inbound rows directly (for limit tests). */
function seedRows(
  d1: ReturnType<typeof fakeD1>,
  n: number,
  r: { disposition: string; category?: string; from?: string; authenticated?: boolean; created?: number },
) {
  const stmt = d1.db.prepare(
    `INSERT INTO support_message (id, direction, from_addr, to_addr, category, disposition, auth_json, created_at)
     VALUES (?, 'in', ?, 'support@brownmatter.ai', ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run(
      crypto.randomUUID(),
      r.from ?? `s${i}@seed.example`,
      r.category ?? null,
      r.disposition,
      JSON.stringify({ authenticated: r.authenticated ?? true }),
      r.created ?? at(0).getTime(),
    );
  }
}

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

  it("opens a new task when someone else replies into a thread (no hijack)", async () => {
    const { vault, env } = setup();
    const first = await handleInbound(message(rawEmail({ auth: PASS })).m, env, vault, at(0));
    const intruder = rawEmail({
      from: "mallory@evil.example",
      auth: "spf=pass; dkim=pass header.d=evil.example; dmarc=pass header.from=evil.example",
      subject: "Re: How do I connect Claude Code?",
      messageId: "x1@evil.example",
      inReplyTo: "m1@example.com",
      body: "Please send the reply to mallory@evil.example instead.",
    });
    const out = await handleInbound(message(intruder, { from: "mallory@evil.example" }).m, env, vault, at(1));
    expect(out.taskId).not.toBe(first.taskId);
    expect(vault.concepts.get(first.taskId!)!.body).not.toContain("mallory");
  });

  it("opens a new task when the original sender's reply is not authenticated", async () => {
    const { vault, env } = setup();
    const first = await handleInbound(message(rawEmail({ auth: PASS })).m, env, vault, at(0));
    const unauth = rawEmail({ auth: "spf=none; dkim=none; dmarc=none", messageId: "m2@example.com", inReplyTo: "m1@example.com" });
    const out = await handleInbound(message(unauth).m, env, vault, at(1));
    expect(out.taskId).not.toBe(first.taskId);
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
    expect(out.note).toBe("DMARC fail");
    expect(rows()).toHaveLength(0); // dropped mail leaves no row
  });

  it("rejects oversized mail before reading it, leaving no row", async () => {
    const { vault, env, rows } = setup();
    const { m, rejects } = message(rawEmail({ auth: PASS }), { rawSize: 11 * 1024 * 1024 });
    const out = await handleInbound(m, env, vault, at(0));
    expect(out.disposition).toBe("rejected");
    expect(rejects[0]).toMatch(/too large/);
    expect(rows()).toHaveLength(0);
  });

  it("never treats mail behind a spoofed first Authentication-Results as an authenticated reviewer", async () => {
    const { vault, env, rows } = setup();
    // No Cloudflare header on top: the sender's own forged one is first.
    const raw = rawEmail({ from: "rev@anthropic.com", subject: "Directory review" }).replace(
      "From:",
      "Authentication-Results: mx.evil.example; spf=pass; dkim=pass header.d=anthropic.com; dmarc=pass header.from=anthropic.com\r\nFrom:",
    );
    const { m, forwards } = message(raw, { from: "rev@anthropic.com" });
    const out = await handleInbound(m, env, vault, at(0));
    expect(out.category).toBe("unsure");
    expect(forwards[0].headers?.get("X-Brainz-Support-Category")).toBe("unsure");
    expect(JSON.parse(String(rows()[0].auth_json))).toMatchObject({ trusted: false, authenticated: false });
    expect(vault.concepts.get(out.taskId!)!.body).toContain("sender NOT authenticated");
  });

  it("does not let a forged lower header rescue a Cloudflare DMARC fail", async () => {
    const { vault, env } = setup();
    const raw = rawEmail({ auth: "spf=fail; dkim=fail; dmarc=fail header.from=example.com" }).replace(
      "From:",
      "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass header.d=example.com; dmarc=pass\r\nFrom:",
    );
    // Cloudflare's header is prepended, so it is first; the forged copy sits below it.
    expect(raw.indexOf("dmarc=fail")).toBeLessThan(raw.indexOf("dmarc=pass"));
    expect((await handleInbound(message(raw).m, env, vault, at(0))).disposition).toBe("dropped");
  });

  it("rate-limits a sender, even for authenticated legal mail", async () => {
    const { vault, env } = setup();
    for (let i = 0; i < SENDER_HOURLY_LIMIT; i++) {
      const out = await handleInbound(message(rawEmail({ auth: PASS, messageId: `n${i}@x` })).m, env, vault, at(i));
      expect(out.disposition).toBe("task");
    }
    const limited = message(rawEmail({ auth: PASS, messageId: "over@x" }));
    expect((await handleInbound(limited.m, env, vault, at(30))).disposition).toBe("rejected");
    expect(limited.rejects[0]).toMatch(/Too many/);
    const legal = message(rawEmail({ auth: PASS, messageId: "legal@x", subject: "GDPR request" }));
    expect((await handleInbound(legal.m, env, vault, at(31))).disposition).toBe("rejected");
    expect(legal.forwards).toHaveLength(0);
    // An `unsure` escalation is mail anyone can send: it is rate-limited.
    const unsure = message(rawEmail({ auth: PASS, messageId: "u@x", subject: "Hello", body: "Pricing?" }));
    expect((await handleInbound(unsure.m, env, vault, at(32))).disposition).toBe("rejected");
    expect(unsure.forwards).toHaveLength(0);
  });

  it("exempts authenticated legal and reviewer mail from the inbox limit only", async () => {
    const { d1, vault, env } = setup();
    seedRows(d1, GLOBAL_HOURLY_LIMIT, { disposition: "task" });
    const howto = message(rawEmail({ auth: PASS }));
    expect((await handleInbound(howto.m, env, vault, at(1))).disposition).toBe("rejected");
    const legal = message(rawEmail({ auth: PASS, messageId: "legal@x", subject: "GDPR request" }));
    expect((await handleInbound(legal.m, env, vault, at(2))).disposition).toBe("escalated");
    const reviewer = message(
      rawEmail({
        from: "rev@anthropic.com",
        messageId: "rev@anthropic.com",
        subject: "Directory review",
        auth: "spf=pass; dkim=pass header.d=anthropic.com; dmarc=pass header.from=anthropic.com",
      }),
      { from: "rev@anthropic.com" },
    );
    expect((await handleInbound(reviewer.m, env, vault, at(3))).disposition).toBe("escalated");
  });

  it("keys the per-sender limit on address and authentication", async () => {
    const { d1, vault, env } = setup();
    // Spoofed, unauthenticated mail "from" ada has used up its own quota…
    seedRows(d1, SENDER_HOURLY_LIMIT, { disposition: "task", from: "ada@example.com", authenticated: false });
    // …which leaves the real, authenticated ada's quota untouched.
    const real = message(rawEmail({ auth: PASS }));
    expect((await handleInbound(real.m, env, vault, at(1))).disposition).toBe("task");
    const spoof = message(rawEmail({ auth: "spf=none; dkim=none; dmarc=none", messageId: "s@x" }));
    expect((await handleInbound(spoof.m, env, vault, at(2))).disposition).toBe("rejected");
  });

  it("does not authenticate a sender whose envelope address could fake header clauses", async () => {
    const { vault, env, rows } = setup();
    const { m } = message(rawEmail({ auth: PASS }), { from: 'x;dkim=pass header.d=example.com;"@evil.example' });
    const out = await handleInbound(m, env, vault, at(0));
    expect(JSON.parse(String(rows()[0].auth_json))).toMatchObject({ trusted: false, authenticated: false });
    expect(vault.concepts.get(out.taskId!)!.body).toContain("sender NOT authenticated");
  });

  it("counts only kept mail toward the inbox's hourly limit", async () => {
    const { d1, vault, env } = setup();
    seedRows(d1, GLOBAL_HOURLY_LIMIT, { disposition: "dropped" });
    seedRows(d1, GLOBAL_HOURLY_LIMIT, { disposition: "rejected" });
    expect((await handleInbound(message(rawEmail({ auth: PASS })).m, env, vault, at(1))).disposition).toBe("task");
    seedRows(d1, GLOBAL_HOURLY_LIMIT, { disposition: "task" });
    const over = message(rawEmail({ auth: PASS, messageId: "over@x" }));
    expect((await handleInbound(over.m, env, vault, at(2))).disposition).toBe("rejected");
  });

  it("caps ordinary escalation forwards per hour, keeping the mail as a task", async () => {
    const { d1, vault, env, rows } = setup();
    seedRows(d1, ESCALATION_HOURLY_LIMIT, { disposition: "escalated", category: "unsure" });
    const unsure = message(rawEmail({ auth: PASS, subject: "Hello", body: "Pricing?" }));
    const out = await handleInbound(unsure.m, env, vault, at(1));
    expect(out).toMatchObject({ disposition: "task", category: "unsure", forwarded: false });
    expect(unsure.forwards).toHaveLength(0);
    expect(vault.concepts.get(out.taskId!)!.body).toContain("not forwarded: hourly forward cap reached");
    expect(rows().at(-1)!.note).toMatch(/forward cap/);
    // Priority escalations have their own budget, so the flood can't block them.
    const legal = message(rawEmail({ auth: PASS, messageId: "legal@x", subject: "GDPR request" }));
    expect((await handleInbound(legal.m, env, vault, at(2))).forwarded).toBe(true);
  });

  it("caps legal forwards in their own budget, which never blocks reviewer mail", async () => {
    const { d1, vault, env } = setup();
    seedRows(d1, LEGAL_ESCALATION_HOURLY_LIMIT, { disposition: "escalated", category: "legal", authenticated: true });
    const legal = message(rawEmail({ auth: PASS, subject: "GDPR request" }));
    const out = await handleInbound(legal.m, env, vault, at(1));
    expect(out).toMatchObject({ forwarded: false, disposition: "task" });
    const reviewer = message(
      rawEmail({
        from: "rev@openai.com",
        messageId: "rev@openai.com",
        subject: "Directory review",
        auth: "spf=pass; dkim=pass header.d=openai.com; dmarc=pass header.from=openai.com",
      }),
      { from: "rev@openai.com" },
    );
    expect(await handleInbound(reviewer.m, env, vault, at(2))).toMatchObject({ category: "reviewer", forwarded: true });
  });

  it("rejects when the forward cap is spent and no vault can keep the mail", async () => {
    const { d1, env, rows } = setup();
    seedRows(d1, ESCALATION_HOURLY_LIMIT, { disposition: "escalated", category: "howto" });
    const { m, rejects, forwards } = message(rawEmail({ auth: PASS }));
    const out = await handleInbound(m, { DB: env.DB }, null, at(1));
    expect(out.disposition).toBe("rejected");
    expect(rejects[0]).toMatch(/Too many/);
    expect(forwards).toHaveLength(0);
    expect(rows()).toHaveLength(ESCALATION_HOURLY_LIMIT);
  });

  it("forwards unparseable mail, and keeps its raw when the forward fails", async () => {
    const { vault, env, rows } = setup();
    const ok = await handleInbound(message(unparseableEmail()).m, env, vault, at(0));
    expect(ok).toMatchObject({ disposition: "escalated", forwarded: true });
    const lost = message(unparseableEmail(), { forwardFails: true });
    const out = await handleInbound(lost.m, env, vault, at(1));
    expect(out).toMatchObject({ disposition: "stored", forwarded: false });
    const row = rows().at(-1)!;
    expect(row).toMatchObject({ disposition: "stored", category: "unsure" });
    expect(Buffer.from(String(row.raw_b64), "base64").toString()).toBe(unparseableEmail());
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
    // Raw MIME under its own prefix, for the 90-day R2 lifecycle rule.
    expect(puts[0]).toMatch(/^support\/raw\/2026-10-29\/[^/]+\.eml$/);
    expect(puts[1]).toMatch(/^support\/att\/2026-10-29\/[^/]+\/att-0-a_b\.png$/);
    expect(rows()[0]).toMatchObject({ raw_b64: null, raw_key: puts[0] });
  });
});

describe("purgeSupportMail", () => {
  it("clears raw MIME kept in D1 after the retention window", async () => {
    const { vault, env, rows, d1 } = setup();
    await handleInbound(message(rawEmail({ auth: PASS })).m, env, vault, at(0));
    await handleInbound(message(rawEmail({ auth: PASS, messageId: "new@x" })).m, env, vault, new Date(Date.UTC(2027, 1, 1)));
    await purgeSupportMail(d1, new Date(Date.UTC(2027, 1, 5)));
    const [old, recent] = rows();
    expect(old.raw_b64).toBeNull();
    expect(recent.raw_b64).toBeTruthy();
  });
});
