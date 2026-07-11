import { describe, expect, it, vi } from "vitest";
import type { SendEmail } from "@cloudflare/workers-types";

// `cloudflare:email` is a workerd-only module; vitest runs in Node, so stub it
// with a minimal EmailMessage that records the (from, to, rawMime) it was
// constructed with. This lets us assert the mailer builds a real raw-MIME
// EmailMessage and hands it to binding.send().
vi.mock("cloudflare:email", () => ({
  EmailMessage: class {
    constructor(
      public readonly from: string,
      public readonly to: string,
      public readonly raw: string,
    ) {}
  },
}));

import {
  claimApprovalTemplate,
  claimNoticeTemplate,
  createMailer,
  DevMailer,
  FROM_ADDRESS,
  inviteTemplate,
  MailChannelsMailer,
  magicLinkTemplate,
} from "./mailer";

describe("mailer selection", () => {
  it("uses MailChannelsMailer when the send_email binding exists", () => {
    const binding = { send: vi.fn() } as unknown as SendEmail;
    expect(createMailer({ SEND_EMAIL: binding })).toBeInstanceOf(MailChannelsMailer);
  });

  it("falls back to DevMailer when the binding is absent", () => {
    expect(createMailer({})).toBeInstanceOf(DevMailer);
  });
});

describe("MailChannelsMailer", () => {
  it("sends a raw-MIME EmailMessage from no-reply@brownmatter.ai with HTML + text and the link", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "x" });
    const binding = { send } as unknown as SendEmail;
    const url = "https://brainz.brownmatter.ai/api/auth/magic-link/verify?token=abc";
    await new MailChannelsMailer(binding).sendMagicLink({ to: "u@example.com", url });

    expect(send).toHaveBeenCalledTimes(1);
    // Must be an EmailMessage (raw MIME) — NOT the old {from,to,subject,...} object.
    const msg = send.mock.calls[0][0] as { from: string; to: string; raw: string };
    expect(msg.from).toBe(FROM_ADDRESS);
    expect(msg.to).toBe("u@example.com");
    expect(typeof msg.raw).toBe("string");

    // The raw MIME carries the sender, subject, and BOTH text + html parts, each
    // containing the magic-link URL.
    expect(msg.raw).toContain(FROM_ADDRESS);
    expect(msg.raw.toLowerCase()).toContain("subject:");
    expect(msg.raw).toMatch(/sign in to brainz/i);
    expect(msg.raw).toContain("text/plain");
    expect(msg.raw).toContain("text/html");
    // MIME may quoted-printable-encode "=" in the URL as "=3D"; check the token
    // portion which survives encoding, plus the host.
    expect(msg.raw).toContain("brainz.brownmatter.ai");
    expect(msg.raw).toContain("token");
  });
});

describe("MailChannelsMailer graceful degradation", () => {
  it("does NOT throw when the binding send() rejects — it logs instead", async () => {
    // Simulates the production failure: Cloudflare's Email Sending rejects an
    // unverified recipient, so binding.send() throws. sendMagicLink must
    // resolve (so the auth request would not 500) and log the real error.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = Object.assign(new Error("E_RECIPIENT_SUPPRESSED"), {
      cause: new Error("recipient not verified"),
    });
    const send = vi.fn().mockRejectedValue(boom);
    const binding = { send } as unknown as SendEmail;

    await expect(
      new MailChannelsMailer(binding).sendMagicLink({
        to: "unverified@example.com",
        url: "https://brainz.brownmatter.ai/api/auth/magic-link/verify?token=abc",
      }),
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(logged).toContain("E_RECIPIENT_SUPPRESSED");
    expect(logged).toContain("recipient not verified");
    // The token/URL must never be logged on the failure path.
    expect(logged).not.toContain("token=abc");
    spy.mockRestore();
  });
});

describe("DevMailer", () => {
  it("captures the last link and logs to stderr instead of sending", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mailer = new DevMailer();
    const url = "http://localhost:5173/api/auth/magic-link/verify?token=xyz";
    await mailer.sendMagicLink({ to: "dev@example.com", url });
    expect(mailer.lastLink).toEqual({ to: "dev@example.com", url });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(" ")).toContain(url);
    spy.mockRestore();
  });
});

describe("templates", () => {
  it("magic-link template is Brownmatter-branded and single-button", () => {
    const tpl = magicLinkTemplate("https://x/verify?token=t");
    expect(tpl.html).toContain("💩 Brainz");
    expect(tpl.text).toContain("💩 Brainz");
    expect(tpl.html).toContain("https://x/verify?token=t");
    // Exactly one action button (anchor).
    expect((tpl.html.match(/<a /g) ?? []).length).toBe(1);
    expect(tpl.html).toContain("Brainz is a Brownmatter product.");
  });

  it("escapes HTML in the heading/intro but preserves the URL", () => {
    // URL is placed in an href and body; the template must not break on it.
    const tpl = magicLinkTemplate("https://x/verify?token=a&b=c");
    expect(tpl.html).toContain("https://x/verify?token=a&amp;b=c");
  });

  it("invite template names the project", () => {
    const tpl = inviteTemplate("https://x/invite/tok", "Acme Brain");
    expect(tpl.subject).toContain("Acme Brain");
    expect(tpl.html).toContain("Acme Brain");
    expect(tpl.html).toContain("https://x/invite/tok");
  });

  it("claim-approval template shows what's being approved: agent framing, vault, key prefix, 24h", () => {
    const tpl = claimApprovalTemplate({
      url: "https://x/claim/tok",
      vaultName: "Agent Vault",
      keyName: "agent-signup",
      keyPrefix: "bz_a1B2c…",
    });
    expect(tpl.subject).toMatch(/agent/i);
    expect(tpl.html).toContain("💩 Brainz");
    expect(tpl.html).toContain("Agent Vault");
    expect(tpl.html).toContain("agent-signup");
    expect(tpl.html).toContain("bz_a1B2c…");
    expect(tpl.html).toContain("https://x/claim/tok");
    expect(tpl.text).toContain("https://x/claim/tok");
    expect(tpl.html).toMatch(/24 hours/);
    // Exactly one action button.
    expect((tpl.html.match(/<a /g) ?? []).length).toBe(1);
  });

  it("claim-notice template has NO token link — only the sign-in page", () => {
    const tpl = claimNoticeTemplate();
    expect(tpl.subject).toMatch(/agent/i);
    expect(tpl.html).toContain("💩 Brainz");
    expect(tpl.html).toMatch(/already have an account/i);
    expect(tpl.html).not.toContain("/claim/");
    expect(tpl.text).not.toContain("/claim/");
    expect(tpl.html).toContain("https://brainz.brownmatter.ai/login");
  });
});

describe("claim emails through the mailers", () => {
  it("MailChannelsMailer sends the approval email as raw MIME with the claim URL", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "x" });
    const binding = { send } as unknown as SendEmail;
    await new MailChannelsMailer(binding).sendClaimApproval({
      to: "human@example.com",
      url: "https://brainz.brownmatter.ai/claim/deadbeef",
      vaultName: "Agent Vault",
      keyName: "agent-signup",
      keyPrefix: "bz_a1B2c…",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as { from: string; to: string; raw: string };
    expect(msg.from).toBe(FROM_ADDRESS);
    expect(msg.to).toBe("human@example.com");
    expect(msg.raw).toContain("Agent Vault");
    expect(msg.raw).toContain("/claim/deadbeef");
  });

  it("DevMailer captures lastLink for approval emails (e2e harness seam)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mailer = new DevMailer();
    await mailer.sendClaimApproval({
      to: "human@example.com",
      url: "http://localhost:8788/claim/deadbeef",
      vaultName: "V",
      keyName: "k",
      keyPrefix: "bz_x…",
    });
    expect(mailer.lastLink).toEqual({
      to: "human@example.com",
      url: "http://localhost:8788/claim/deadbeef",
    });
    expect(spy.mock.calls[0].join(" ")).toContain("/claim/deadbeef");
    spy.mockRestore();
  });

  it("DevMailer records notice sends without ever logging a token", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mailer = new DevMailer();
    await mailer.sendClaimNotice({ to: "human@example.com" });
    expect(mailer.lastLink?.to).toBe("human@example.com");
    expect(spy.mock.calls[0].join(" ")).not.toContain("/claim/");
    spy.mockRestore();
  });
});
