/**
 * Outbound email — magic links and (future) invites.
 *
 * Two implementations behind one `Mailer` interface, selected by whether the
 * Cloudflare `send_email` binding is present:
 *   - `MailChannelsMailer` — production. Sends through the `SEND_EMAIL`
 *     Worker binding, FROM `no-reply@brownmatter.ai`, DKIM-signed. Requires
 *     the DNS/DKIM records the deploy runbook sets up. (Name is historical:
 *     Cloudflare retired the MailChannels transport in Aug 2024; the binding
 *     now sends through Cloudflare's native Email Service — same binding, same
 *     DKIM setup.)
 *   - `DevMailer` — local dev / tests / any deploy without the binding. Logs
 *     the link URL to stderr instead of sending, and records it in-memory so a
 *     harness can capture it (see `lastLink`). NEVER used when the binding
 *     exists, so tokens are never console-logged in production.
 *
 * Templates are Brownmatter-branded (💩 wordmark, one clear button), HTML +
 * plain-text. Nothing here logs the token in prod.
 */
import { createMimeMessage } from "mimetext";
import type { SendEmail } from "@cloudflare/workers-types";

// `cloudflare:email` (provides `EmailMessage` for the send_email binding) is a
// workerd-only built-in with no Node implementation. A STATIC top-level import
// breaks the SvelteKit build, because adapter-cloudflare evaluates the SSR
// bundle in Node to prerender/emit the worker. Import it LAZILY at runtime
// (inside send()) so the module scheme is only resolved by workerd, never by
// Node during the build. The unit test stubs this same module via vi.mock.
async function loadEmailMessageCtor(): Promise<
  new (from: string, to: string, raw: string) => unknown
> {
  const mod = (await import("cloudflare:email")) as {
    EmailMessage: new (from: string, to: string, raw: string) => unknown;
  };
  return mod.EmailMessage;
}

export interface Mailer {
  /** Deliver a magic sign-in link to `to`. */
  sendMagicLink(args: { to: string; url: string }): Promise<void>;
  /** Deliver a project-invite link (Wave P uses this; optional for now). */
  sendInvite?(args: { to: string; url: string; projectName: string }): Promise<void>;
}

/** Sender identity — must be an address on the DKIM-configured sending domain. */
export const FROM_ADDRESS = "no-reply@brownmatter.ai";
export const FROM_NAME = "Brainz";

// ----------------------------------------------------------------- templates

interface Template {
  subject: string;
  text: string;
  html: string;
}

/** Shared Brownmatter-branded button email. `preheader` is the inbox snippet. */
function brandedEmail(opts: {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  buttonLabel: string;
  url: string;
  footnote: string;
}): Template {
  const text = [
    `💩 Brainz`,
    ``,
    opts.heading,
    ``,
    opts.intro,
    ``,
    opts.url,
    ``,
    opts.footnote,
    ``,
    `— Brainz, a Brownmatter product`,
  ].join("\n");

  // Inline styles only (email clients strip <style>); dark, on-brand.
  const html = `<!-- ${escapeHtml(opts.preheader)} -->
<div style="background:#0f0f11;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e7e7ea;">
  <div style="max-width:440px;margin:0 auto;background:#17171a;border:1px solid #26262b;border-radius:14px;padding:32px;">
    <div style="font-size:20px;font-weight:700;margin-bottom:24px;letter-spacing:-0.02em;">💩 Brainz</div>
    <h1 style="font-size:19px;font-weight:600;margin:0 0 12px;color:#fff;">${escapeHtml(opts.heading)}</h1>
    <p style="font-size:14.5px;line-height:1.55;margin:0 0 24px;color:#b7b7bd;">${escapeHtml(opts.intro)}</p>
    <a href="${escapeAttr(opts.url)}" style="display:inline-block;background:#7c5cff;color:#fff;text-decoration:none;font-weight:600;font-size:14.5px;padding:12px 22px;border-radius:9px;">${escapeHtml(opts.buttonLabel)}</a>
    <p style="font-size:12.5px;line-height:1.5;margin:24px 0 0;color:#7a7a82;">${escapeHtml(opts.footnote)}</p>
    <p style="font-size:12px;line-height:1.5;margin:16px 0 0;color:#55555c;word-break:break-all;">Or paste this link:<br>${escapeHtml(opts.url)}</p>
  </div>
  <p style="max-width:440px;margin:16px auto 0;font-size:11.5px;color:#55555c;text-align:center;">Brainz is a Brownmatter product.</p>
</div>`;

  return { subject: opts.subject, text, html };
}

export function magicLinkTemplate(url: string): Template {
  return brandedEmail({
    subject: "Sign in to Brainz",
    preheader: "Your one-time sign-in link for Brainz.",
    heading: "Sign in to Brainz",
    intro:
      "Click the button below to sign in. This link is single-use and expires in about 15 minutes. " +
      "If you didn't request it, you can safely ignore this email.",
    buttonLabel: "Sign in to Brainz",
    url,
    footnote: "This link works once. Requesting a new one invalidates older links.",
  });
}

export function inviteTemplate(url: string, projectName: string): Template {
  return brandedEmail({
    subject: `You've been invited to ${projectName} on Brainz`,
    preheader: `Join ${projectName} on Brainz.`,
    heading: `Join ${projectName}`,
    intro:
      `You've been invited to collaborate on the ${projectName} knowledge graph on Brainz. ` +
      "Click below to accept and sign in — no password needed.",
    buttonLabel: "Accept invite",
    url,
    footnote: "If you weren't expecting this, you can ignore it.",
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// ------------------------------------------------------------ implementations

/** Production mailer over the Cloudflare `send_email` binding. */
export class MailChannelsMailer implements Mailer {
  constructor(private readonly binding: SendEmail) {}

  private async send(to: string, tpl: Template): Promise<void> {
    // Cloudflare's `send_email` binding accepts a raw-MIME `EmailMessage`:
    //   new EmailMessage(fromAddr, toAddr, rawMimeString)  →  binding.send(msg)
    // We build the MIME with `mimetext` (pure-JS, Workers-safe): sender,
    // recipient, subject, then BOTH a text/plain and a text/html part so
    // clients render the branded HTML with a plain-text fallback. This is the
    // authoritative, universally-supported API — the older object/builder
    // overload was NOT delivering (send() effectively no-op/threw), which is
    // why 200s were returned but no email arrived.
    //
    // GRACEFUL DEGRADATION (intentional): the real `send_email` binding THROWS
    // when it cannot deliver — e.g. the sending domain is not onboarded for
    // Email Sending, the sender identity is unverified, or the recipient is a
    // non-verified address on an Email-Routing-only setup. Letting that throw
    // propagate would 500 the sign-in request even though Better Auth already
    // minted a valid token. Instead we swallow the error and log it LOUDLY
    // (name + message + stack + cause) so the real Cloudflare error is
    // unmissable in `wrangler tail`. The magic-link token still exists; only
    // DELIVERY failed. On success this method is silent (no log line).
    try {
      const mime = createMimeMessage();
      mime.setSender({ name: FROM_NAME, addr: FROM_ADDRESS });
      mime.setRecipient(to);
      mime.setSubject(tpl.subject);
      // text/plain first (fallback), then text/html (preferred by clients).
      mime.addMessage({ contentType: "text/plain", data: tpl.text });
      mime.addMessage({ contentType: "text/html", data: tpl.html });

      const EmailMessage = await loadEmailMessageCtor();
      const message = new EmailMessage(FROM_ADDRESS, to, mime.asRaw());
      // The first SendEmail.send overload takes a raw-MIME EmailMessage.
      await this.binding.send(message as Parameters<SendEmail["send"]>[0]);
    } catch (err) {
      logSendFailure(to, err);
      // Deliberately not rethrown: a delivery failure must not fail the
      // (already-successful) auth request or leak that send failed to the user.
    }
  }

  async sendMagicLink({ to, url }: { to: string; url: string }): Promise<void> {
    await this.send(to, magicLinkTemplate(url));
  }

  async sendInvite({ to, url, projectName }: { to: string; url: string; projectName: string }): Promise<void> {
    await this.send(to, inviteTemplate(url, projectName));
  }
}

/**
 * Log an email-send failure loudly (name + message + stack + any nested cause)
 * so the real Cloudflare error is unmissable in `wrangler tail`. A real send
 * failure must never be silent. Never includes the token/URL.
 */
function logSendFailure(to: string, err: unknown): void {
  const name = err instanceof Error ? err.name : "NonError";
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? ` stack=${err.stack}` : "";
  const cause =
    err instanceof Error && err.cause
      ? ` cause=${String((err.cause as Error)?.message ?? err.cause)}`
      : "";
  // eslint-disable-next-line no-console
  console.error(`[mailer] email send FAILED to ${to}: ${name}: ${message}${cause}${stack}`);
}

/**
 * Dev/test mailer: logs the link to stderr and remembers the last one so a
 * harness can follow it. Only selected when the `send_email` binding is
 * absent, so this never runs (and never logs a token) in production.
 */
export class DevMailer implements Mailer {
  /** The most recent magic-link URL "sent" — for e2e capture. */
  lastLink: { to: string; url: string } | null = null;

  async sendMagicLink({ to, url }: { to: string; url: string }): Promise<void> {
    this.lastLink = { to, url };
    // eslint-disable-next-line no-console
    console.error(`[DevMailer] magic link for ${to}: ${url}`);
  }

  async sendInvite({ to, url, projectName }: { to: string; url: string; projectName: string }): Promise<void> {
    this.lastLink = { to, url };
    // eslint-disable-next-line no-console
    console.error(`[DevMailer] invite for ${to} to ${projectName}: ${url}`);
  }
}

/**
 * Pick a mailer: MailChannels when the `send_email` binding exists, else the
 * dev logger. In production the binding is always present (wrangler.jsonc), so
 * links are only ever emailed — never console-logged.
 */
export function createMailer(env: { SEND_EMAIL?: SendEmail }): Mailer {
  return env.SEND_EMAIL ? new MailChannelsMailer(env.SEND_EMAIL) : new DevMailer();
}
