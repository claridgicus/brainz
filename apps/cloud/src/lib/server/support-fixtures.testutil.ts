/** Test-only: raw RFC 5322 fixtures and a fake support vault for the support-inbox tests. Not imported by app code. */
import type { SupportVault } from "./support-email";

/** Build a raw RFC 5322 message. */
export function rawEmail(opts: {
  from?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  auth?: string;
  extraHeaders?: string[];
  html?: string;
  attachment?: { filename: string; type: string; content: string };
}): string {
  const lines = [
    ...(opts.auth !== undefined ? [`Authentication-Results: mx.cloudflare.net; ${opts.auth}`] : []),
    `From: ${opts.from ?? "Ada <ada@example.com>"}`,
    "To: support@brownmatter.ai",
    `Subject: ${opts.subject ?? "How do I connect Claude Code?"}`,
    `Message-ID: <${opts.messageId ?? "m1@example.com"}>`,
    ...(opts.inReplyTo ? [`In-Reply-To: <${opts.inReplyTo}>`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    "Date: Wed, 29 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    ...(opts.extraHeaders ?? []),
  ];
  if (opts.attachment) {
    const b = "BOUNDARY42";
    return [
      ...lines,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      opts.body ?? "Hello",
      `--${b}`,
      `Content-Type: ${opts.attachment.type}; name="${opts.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(opts.attachment.content).toString("base64"),
      `--${b}--`,
      "",
    ].join("\r\n");
  }
  if (opts.html) {
    return [...lines, "Content-Type: text/html; charset=utf-8", "", opts.html, ""].join("\r\n");
  }
  return [
    ...lines,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body ?? "Hi, how do I set up the MCP server in Claude Code?",
    "",
  ].join("\r\n");
}

/** In-memory stand-in for the support vault's DO. */
export function fakeVault(): SupportVault & {
  concepts: Map<string, { id: string; title: string; body: string; tags: string[]; taskStatus?: string }>;
  fail?: boolean;
} {
  const concepts = new Map<string, { id: string; title: string; body: string; tags: string[]; taskStatus?: string }>();
  const v = {
    concepts,
    fail: false,
    async getConcept(id: string) {
      return { concept: concepts.get(id) ?? null };
    },
    async upsertConcept(input: { id: string; title: string; body: string; tags: string[]; taskStatus?: string }) {
      if (v.fail) throw new Error("DO unavailable");
      const prev = concepts.get(input.id);
      concepts.set(input.id, { ...prev, ...input, taskStatus: input.taskStatus ?? prev?.taskStatus });
      return {};
    },
    async reopenTask({ id }: { id: string }) {
      const c = concepts.get(id)!;
      c.taskStatus = "open";
      return {};
    },
  };
  return v;
}
