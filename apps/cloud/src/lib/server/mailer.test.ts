import { describe, expect, it, vi } from "vitest";
import type { SendEmail } from "@cloudflare/workers-types";
import {
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
  it("sends from no-reply@brownmatter.ai with HTML + text and the link", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "x" });
    const binding = { send } as unknown as SendEmail;
    const url = "https://brainz.brownmatter.ai/api/auth/magic-link/verify?token=abc";
    await new MailChannelsMailer(binding).sendMagicLink({ to: "u@example.com", url });

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.from.email).toBe(FROM_ADDRESS);
    expect(msg.to).toBe("u@example.com");
    expect(typeof msg.html).toBe("string");
    expect(typeof msg.text).toBe("string");
    expect(msg.html).toContain(url);
    expect(msg.text).toContain(url);
    expect(msg.subject).toMatch(/sign in/i);
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
});
