// Ambient type for the workerd-only `cloudflare:email` built-in module, which
// provides `EmailMessage` for the Cloudflare `send_email` binding used by the
// mailer (src/lib/server/mailer.ts). This file intentionally has NO top-level
// import/export so it is a *script* (global) — a `declare module` here is
// visible program-wide.
//
// We declare it locally instead of adding `/// <reference types=
// "@cloudflare/workers-types" />`, which would pull the full Workers global
// surface into scope and shadow DOM globals (fetch / ReadableStream /
// EmailMessage) that the SvelteKit app and d3 depend on.
declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: ReadableStream | string);
  }
}
