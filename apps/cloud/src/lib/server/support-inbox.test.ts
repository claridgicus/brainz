import { describe, expect, it } from "vitest";
import {
  autoSendBlocker,
  autoSendCategories,
  authservId,
  classifyInbound,
  dropReason,
  escalationClass,
  newTaskBody,
  parseAuthResults,
  parseAuthResultsHeader,
  parseIdList,
  parseInbound,
  quoteUntrusted,
  replySubject,
  senderAuthenticated,
  supportTaskId,
  taskTags,
  type InboundRecord,
  type ParsedInbound,
} from "./support-inbox";
import { rawEmail } from "./support-fixtures.testutil";

const PASS = "spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";

async function parsed(opts: Parameters<typeof rawEmail>[0]): Promise<ParsedInbound> {
  return parseInbound(rawEmail(opts));
}

describe("parseInbound", () => {
  it("extracts sender, subject, ids, text and thread headers", async () => {
    const msg = await parsed({
      auth: PASS,
      inReplyTo: "Parent@Brownmatter.ai",
      references: "<root@example.com> <Parent@Brownmatter.ai>",
    });
    expect(msg.from).toBe("ada@example.com");
    expect(msg.fromName).toBe("Ada");
    expect(msg.subject).toBe("How do I connect Claude Code?");
    expect(msg.messageId).toBe("m1@example.com");
    expect(msg.threadIds).toEqual(["parent@brownmatter.ai", "root@example.com"]);
    expect(msg.text).toContain("set up the MCP server");
    expect(msg.authResults).toHaveLength(1);
  });

  it("falls back to HTML-to-text for HTML-only mail", async () => {
    const msg = await parsed({ html: "<p>Hello <b>there</b></p><script>x()</script><p>second</p>" });
    expect(msg.text).toBe("Hello there\nsecond");
  });

  it("keeps attachment metadata and bytes", async () => {
    const msg = await parsed({ attachment: { filename: "log.txt", type: "text/plain", content: "boom" } });
    expect(msg.attachments).toEqual([{ filename: "log.txt", mimeType: "text/plain", size: 4 }]);
    expect(new TextDecoder().decode(msg.attachmentContents[0])).toBe("boom");
  });

  it("records a differing Reply-To", async () => {
    const msg = await parsed({ extraHeaders: ["Reply-To: other@example.org"] });
    expect(msg.replyTo).toBe("other@example.org");
  });
});

describe("parseIdList", () => {
  it("normalizes bracketed and bare ids", () => {
    expect(parseIdList("<A@x> <b@y>")).toEqual(["a@x", "b@y"]);
    expect(parseIdList("c@z")).toEqual(["c@z"]);
    expect(parseIdList(undefined)).toEqual([]);
  });
});

describe("authentication", () => {
  it("reads the authserv-id", () => {
    expect(authservId("mx.cloudflare.net; spf=pass")).toBe("mx.cloudflare.net");
    expect(authservId(" MX.Cloudflare.NET 1 (comment); dkim=pass")).toBe("mx.cloudflare.net");
    expect(authservId("spf=pass")).toBe("");
  });

  it("trusts only a topmost header whose authserv-id is Cloudflare's", () => {
    const forged = "evil.example; spf=pass; dkim=pass header.d=anthropic.com; dmarc=pass header.from=anthropic.com";
    // A sender-supplied header on top (Cloudflare's missing) reads as "none".
    const spoofed = parseAuthResults([forged, "mx.cloudflare.net; spf=fail; dmarc=fail"]);
    expect(spoofed).toMatchObject({ trusted: false, spf: "none", dkim: "none", dmarc: "none", dkimDomains: [] });
    expect(senderAuthenticated("rev@anthropic.com", spoofed)).toBe(false);
    // A forged header with no authserv-id at all.
    const bare = parseAuthResults(["spf=pass; dkim=pass header.d=anthropic.com; dmarc=pass"]);
    expect(bare.trusted).toBe(false);
    expect(senderAuthenticated("rev@anthropic.com", bare)).toBe(false);
    expect(parseAuthResults([]).trusted).toBe(false);
  });

  it("parses resinfo clauses per RFC 8601: per-clause properties, quotes and comments", () => {
    const h = parseAuthResultsHeader(
      'mx.cloudflare.net (Cloudflare; mx) 1; dkim=pass (2048-bit key; unprotected) header.d="example.com" header.s=cf; ' +
        'spf = pass smtp.mailfrom="a;dmarc=pass"@x.example; dmarc/1=pass (p=REJECT sp=reject) header.from=example.com',
    );
    expect(h.authservId).toBe("mx.cloudflare.net");
    expect(h.results.map((r) => [r.method, r.result])).toEqual([
      ["dkim", "pass"],
      ["spf", "pass"],
      ["dmarc", "pass"],
    ]);
    expect(h.results[0].props.get("header.d")).toBe("example.com");
    expect(h.results[1].props.get("smtp.mailfrom")).toBe("a;dmarc=pass@x.example");
    expect(h.results[2].props.get("header.from")).toBe("example.com");
  });

  it("A: a dmarc=pass inside the envelope sender is not a DMARC result", () => {
    const auth = parseAuthResults([
      "mx.cloudflare.net; spf=pass smtp.mailfrom=dmarc=pass@evil.example; dkim=none; dmarc=fail header.from=victim.example",
    ]);
    expect(auth.dmarc).toBe("fail");
    expect(senderAuthenticated("x@victim.example", auth)).toBe(false);
  });

  it("B: a dkim=pass header.d= inside the envelope sender is not a DKIM signature", () => {
    const auth = parseAuthResults([
      "mx.cloudflare.net; spf=pass smtp.mailfrom=dkim=pass.header.d=anthropic.com@evil.example; dkim=none; dmarc=none",
    ]);
    expect(auth.dkimDomains).toEqual([]);
    expect(auth.dkim).toBe("none");
    expect(senderAuthenticated("rev@anthropic.com", auth)).toBe(false);
  });

  it("ignores result-looking text in comments and quoted values", () => {
    const auth = parseAuthResults([
      'mx.cloudflare.net; spf=fail (dmarc=pass header.from=victim.example) smtp.mailfrom="dkim=pass header.d=victim.example"@e.x; dkim=none; dmarc=none',
    ]);
    expect(auth).toMatchObject({ spf: "fail", dkim: "none", dkimDomains: [], dmarc: "none" });
  });

  it("requires the dmarc clause to state header.from", () => {
    const auth = parseAuthResults(["mx.cloudflare.net; spf=pass; dkim=none; dmarc=pass"]);
    expect(auth.dmarcFrom).toBeNull();
    expect(senderAuthenticated("x@example.com", auth)).toBe(false);
  });

  it("is untrusted without exactly one spf and one dmarc clause, or without a dkim clause", () => {
    const base = "spf=pass; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";
    expect(parseAuthResults([`mx.cloudflare.net; ${base}`]).trusted).toBe(true);
    // Several dkim clauses are normal (sender + ESP signatures).
    expect(parseAuthResults([`mx.cloudflare.net; ${base}; dkim=pass header.d=other.example`]).trusted).toBe(true);
    for (const header of [
      "mx.cloudflare.net; spf=pass; dmarc=pass header.from=example.com",
      "mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      "mx.cloudflare.net; spf=pass; dkim=pass header.d=example.com",
      `mx.cloudflare.net; ${base}; dmarc=fail header.from=example.com`,
      `mx.cloudflare.net; ${base}; spf=fail`,
    ]) {
      const auth = parseAuthResults([header]);
      expect(auth.trusted, header).toBe(false);
      expect(senderAuthenticated("x@example.com", auth), header).toBe(false);
    }
  });

  // The reviewer's probes: envelope senders that try to fake clause or comment
  // boundaries in Cloudflare's own header.
  const PROBE_1_ENVELOPE = 'x); dkim=pass header.d=victim.example; y=("@evil.example';
  const PROBE_1 =
    'mx.cloudflare.net; dkim=none; spf=pass (domain of "x); dkim=pass header.d=victim.example; y=("@evil.example designates 192.0.2.1) ' +
    "smtp.mailfrom=x; dmarc=none header.from=victim.example";
  const PROBE_2_ENVELOPE = "x;dkim=pass header.d=victim.example;@evil.example";
  const PROBE_2 =
    "mx.cloudflare.net; dkim=none; spf=pass smtp.mailfrom=x;dkim=pass header.d=victim.example;@evil.example; dmarc=none header.from=victim.example";

  // The envelope check is what stops these: Cloudflare echoes the envelope
  // sender into its header, and a smuggled dkim clause is indistinguishable
  // from an ESP's second signature.
  it("probe 1 (quote + comment boundaries) is not authenticated", () => {
    const auth = parseAuthResults([PROBE_1], PROBE_1_ENVELOPE);
    expect(auth.trusted).toBe(false);
    expect(senderAuthenticated("ceo@victim.example", auth)).toBe(false);
  });

  it("probe 2 (bare ; in the envelope sender) is not authenticated", () => {
    const auth = parseAuthResults([PROBE_2], PROBE_2_ENVELOPE);
    expect(auth.trusted).toBe(false);
    expect(senderAuthenticated("ceo@victim.example", auth)).toBe(false);
  });

  it("authenticates mail with two passing DKIM signatures (sender domain + ESP)", () => {
    const auth = parseAuthResults(
      [
        "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1 header.b=abc; " +
          "dkim=pass header.d=sendgrid.net header.s=smtpapi header.b=def; " +
          "spf=pass smtp.mailfrom=bounces+123@em.example.com; dmarc=pass (p=REJECT) header.from=example.com",
      ],
      "bounces+123@em.example.com",
    );
    expect(auth).toMatchObject({ trusted: true, dkim: "pass", dkimDomains: ["example.com", "sendgrid.net"], dmarc: "pass" });
    expect(senderAuthenticated("ada@example.com", auth)).toBe(true);
    // The ESP's signature alone authenticates neither the ESP's nor another domain via DMARC.
    expect(senderAuthenticated("x@other.example", auth)).toBe(false);
  });

  it("takes DKIM domains only from passing signatures", () => {
    const auth = parseAuthResults(
      ["mx.cloudflare.net; dkim=fail header.d=victim.example; dkim=pass header.d=example.com; spf=none; dmarc=none"],
      "a@example.com",
    );
    expect(auth.dkimDomains).toEqual(["example.com"]);
    expect(senderAuthenticated("x@victim.example", auth)).toBe(false);
  });

  it("distrusts any envelope sender with ; ( ) \" \\ or whitespace", () => {
    const good = "mx.cloudflare.net; spf=pass; dkim=pass header.d=example.com; dmarc=pass header.from=example.com";
    expect(parseAuthResults([good], "bounce+123@example.com").trusted).toBe(true);
    expect(parseAuthResults([good], "").trusted).toBe(true);
    for (const env of ["a;b@example.com", "a(b@example.com", "a)b@example.com", '"a"@example.com', "a\\b@example.com", "a b@example.com", "a\tb@example.com"]) {
      expect(parseAuthResults([good], env).trusted, env).toBe(false);
    }
  });

  it("uses a DKIM signature only when the domain publishes no DMARC policy", () => {
    const none = parseAuthResults(["mx.cloudflare.net; spf=none; dkim=pass header.d=example.com; dmarc=none"]);
    expect(senderAuthenticated("x@example.com", none)).toBe(true);
    const other = parseAuthResults(["mx.cloudflare.net; spf=none; dkim=pass header.d=example.com; dmarc=temperror header.from=example.com"]);
    expect(senderAuthenticated("x@example.com", other)).toBe(false);
  });

  it("does not count a DMARC pass evaluated for another From domain", () => {
    const auth = parseAuthResults(["mx.cloudflare.net; spf=pass; dkim=none; dmarc=pass header.from=attacker.example"]);
    expect(senderAuthenticated("rev@anthropic.com", auth)).toBe(false);
    expect(senderAuthenticated("x@attacker.example", auth)).toBe(true);
  });

  it("classifies a reviewer claim behind a spoofed first header as unsure, not reviewer", async () => {
    const raw = rawEmail({
      from: "rev@anthropic.com",
      auth: undefined,
      extraHeaders: [],
    }).replace(
      "From:",
      "Authentication-Results: evil.example; spf=pass; dkim=pass header.d=anthropic.com; dmarc=pass header.from=anthropic.com\r\nFrom:",
    );
    const msg = await parseInbound(raw);
    const auth = parseAuthResults(msg.authResults);
    expect(classifyInbound(msg, auth)).toMatchObject({ category: "unsure", escalate: true });
  });

  it("reads the topmost Authentication-Results only", () => {
    const auth = parseAuthResults([
      "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail header.from=anthropic.com",
      "evil.example; spf=pass; dkim=pass header.d=anthropic.com; dmarc=pass",
    ]);
    expect(auth).toMatchObject({ spf: "fail", dkim: "none", dmarc: "fail", dkimDomains: [] });
  });

  it("collects the passing DKIM domain", () => {
    const auth = parseAuthResults([
      "mx.cloudflare.net; dkim=pass header.d=mail.anthropic.com; spf=pass; dmarc=none",
    ]);
    expect(auth.dkim).toBe("pass");
    expect(auth.dkimDomains).toEqual(["mail.anthropic.com"]);
    expect(senderAuthenticated("x@mail.anthropic.com", auth)).toBe(true);
    expect(senderAuthenticated("x@anthropic.com", auth)).toBe(false);
  });

  it("drops DMARC failures, SPF failures without DKIM, loops and spam flags", async () => {
    const ok = await parsed({ auth: PASS });
    expect(dropReason(ok, parseAuthResults(ok.authResults))).toBeNull();
    const dmarc = parseAuthResults(["mx.cloudflare.net; spf=pass; dkim=pass header.d=example.com; dmarc=fail"]);
    expect(dropReason(ok, dmarc)).toBe("DMARC fail");
    const spf = parseAuthResults(["mx.cloudflare.net; spf=fail; dkim=none; dmarc=none"]);
    expect(dropReason(ok, spf)).toMatch(/SPF fail/);
    const loop = await parsed({ from: "support@brownmatter.ai", auth: PASS });
    expect(dropReason(loop, parseAuthResults(loop.authResults))).toMatch(/loop/);
    const spam = await parsed({ auth: PASS, extraHeaders: ["X-Spam-Flag: YES"] });
    expect(dropReason(spam, parseAuthResults(spam.authResults))).toMatch(/spam/);
  });
});

describe("classifyInbound", () => {
  const classify = async (opts: Parameters<typeof rawEmail>[0]) => {
    const msg = await parsed(opts);
    return classifyInbound(msg, parseAuthResults(msg.authResults));
  };
  const reviewerAuth = (d: string) => `spf=pass; dkim=pass header.d=${d}; dmarc=pass header.from=${d}`;

  it("escalates authenticated directory reviewers", async () => {
    for (const d of ["anthropic.com", "openai.com", "x.ai"]) {
      const c = await classify({ from: `rev@${d}`, auth: reviewerAuth(d), subject: "How do I test?" });
      expect(c).toMatchObject({ category: "reviewer", escalate: true });
    }
    const sub = await classify({ from: "rev@mail.openai.com", auth: reviewerAuth("mail.openai.com") });
    expect(sub.category).toBe("reviewer");
  });

  it("treats an unauthenticated reviewer domain as unsure (escalated)", async () => {
    const c = await classify({ from: "rev@anthropic.com", auth: "spf=none; dkim=none; dmarc=none" });
    expect(c).toMatchObject({ category: "unsure", escalate: true });
    const lookalike = await classify({ from: "rev@notanthropic.com", auth: PASS, subject: "Hello" });
    expect(lookalike.category).not.toBe("reviewer");
  });

  it("escalates legal, privacy and deletion requests", async () => {
    for (const subject of ["GDPR data access request", "Please delete my account", "DMCA takedown"]) {
      const c = await classify({ auth: PASS, subject, body: "See subject." });
      expect(c).toMatchObject({ category: "legal", escalate: true });
    }
  });

  it("routes how-to, bug and feedback mail to the agent without escalating", async () => {
    expect(await classify({ auth: PASS })).toMatchObject({ category: "howto", escalate: false });
    expect(
      await classify({ auth: PASS, subject: "Dashboard broken", body: "I get a 500 error on login." }),
    ).toMatchObject({ category: "bug", escalate: false });
    expect(
      await classify({ auth: PASS, subject: "Feature request", body: "Would be great to have dark mode." }),
    ).toMatchObject({ category: "feedback", escalate: false });
  });

  it("marks auto-generated mail and does not escalate it", async () => {
    const c = await classify({ auth: PASS, subject: "Out of office", body: "Away.", extraHeaders: ["Auto-Submitted: auto-replied"] });
    expect(c).toMatchObject({ category: "auto", escalate: false });
  });

  it("escalates mail it cannot place", async () => {
    expect(await classify({ auth: PASS, subject: "Hello", body: "Quick question about pricing." })).toMatchObject({
      category: "unsure",
      escalate: true,
    });
  });
});

describe("auto-send policy", () => {
  it("is off by default and only honors safe categories", () => {
    expect(autoSendCategories(undefined).size).toBe(0);
    expect([...autoSendCategories("howto, legal, bug")]).toEqual(["howto"]);
  });

  const row = (r: Partial<InboundRecord> = {}): InboundRecord => ({
    fromAddr: "ada@example.com",
    replyTo: null,
    category: "howto",
    disposition: "task",
    authenticated: true,
    ...r,
  });

  it("lets agents send only when every inbound row is enabled, unescalated, authenticated and without Reply-To", () => {
    expect(autoSendBlocker([row()], undefined)).toMatch(/off/);
    expect(autoSendBlocker([row()], "howto")).toBeNull();
    expect(autoSendBlocker([], "howto")).toMatch(/no inbound/);
    expect(autoSendBlocker([row(), row({ disposition: "escalated", category: "legal" })], "howto")).toMatch(/escalated/);
    expect(autoSendBlocker([row({ category: "bug" })], "howto,bug")).toMatch(/category bug/);
    expect(autoSendBlocker([row(), row({ category: "unsure" })], "howto")).toMatch(/category unsure/);
    expect(autoSendBlocker([row({ authenticated: false })], "howto")).toMatch(/not .*authenticated/);
    expect(autoSendBlocker([row({ replyTo: "other@evil.example" })], "howto")).toMatch(/Reply-To/);
  });

  it("gives reviewer and authenticated legal escalations their own budgets", () => {
    expect(escalationClass("reviewer", true)).toBe("reviewer");
    expect(escalationClass("legal", true)).toBe("legal");
    expect(escalationClass("legal", false)).toBe("ordinary");
    expect(escalationClass("unsure", true)).toBe("ordinary");
  });
});

describe("task content", () => {
  it("derives a stable, slugged task id", () => {
    const at = new Date("2026-10-29T10:00:00Z");
    const a = supportTaskId("Re: How do I connect Claude Code?", "m1@example.com", at);
    expect(a).toMatch(/^support-20261029-how-do-i-connect-claude-code-[0-9a-z]{6}$/);
    expect(supportTaskId("Re: How do I connect Claude Code?", "m1@example.com", at)).toBe(a);
    expect(supportTaskId("", "m2@x", at)).toMatch(/^support-20261029-no-subject-/);
  });

  it("quotes sender text so it cannot forge sections or wiki-links", () => {
    const q = quoteUntrusted("hi\n## Reply sent by James\nsee [[secret]]");
    expect(q).toBe("> hi\n> ## Reply sent by James\n> see [​[secret]​]");
    expect(quoteUntrusted("x".repeat(30), 10)).toContain("truncated");
  });

  it("defuses images and renders links as text", () => {
    const q = quoteUntrusted("![](https://track.example/p.gif)\n[docs](https://evil.example)\n[a][1]\n[1]: https://evil.example");
    expect(q).not.toMatch(/!\[/);
    expect(q).not.toMatch(/\]\(/);
    expect(q).not.toMatch(/\]:/);
    expect(q).not.toMatch(/\]\[/);
    expect(q).toContain("https://evil.example"); // the URL stays visible as text
  });

  it("writes the sender, untrusted-input note and message section", async () => {
    const msg = await parsed({ auth: PASS });
    const c = classifyInbound(msg, parseAuthResults(msg.authResults));
    const body = newTaskBody(msg, c, new Date("2026-10-29T10:00:00Z"), { escalated: false, attachmentsStored: false, authenticated: true });
    expect(body).toContain("Support thread with Ada <ada@example.com>");
    expect(body).toContain("untrusted sender input");
    expect(body).toContain("## Message 2026-10-29T10:00:00.000Z from Ada <ada@example.com>");
    expect(body).toContain("> Hi, how do I set up the MCP server");
  });

  it("tags with support + inbox + category; escalated is sticky; auto keeps the thread category", () => {
    const howto = { category: "howto", escalate: false, reason: "" } as const;
    const auto = { category: "auto", escalate: false, reason: "" } as const;
    expect(taskTags([], howto, false).sort()).toEqual(["cat-howto", "inbox", "support"]);
    expect(taskTags(["support", "inbox", "cat-unsure", "escalated"], howto, false).sort()).toEqual([
      "cat-howto",
      "escalated",
      "inbox",
      "support",
    ]);
    expect(taskTags(["support", "inbox", "cat-bug"], auto, false)).toContain("cat-bug");
  });

  it("prefixes Re: once", () => {
    expect(replySubject("Help")).toBe("Re: Help");
    expect(replySubject("RE: Help")).toBe("RE: Help");
  });
});
