// Ambient types for the SvelteKit app (backend-owned; see SPEC-CLOUD.md).
import type { createAuth } from "$lib/server/auth";

/** Cloudflare bindings + secrets available on `event.platform.env`. */
export interface CloudEnv {
  /** D1 control plane (auth tables, vault registry, API keys). */
  DB: import("@cloudflare/workers-types").D1Database;
  /** One Durable Object per vault (DO SQLite data plane). */
  VAULT_DO: import("@cloudflare/workers-types").DurableObjectNamespace;
  /** Workers AI (embeddings: @cf/baai/bge-base-en-v1.5). */
  AI: import("@cloudflare/workers-types").Ai;
  ASSETS: import("@cloudflare/workers-types").Fetcher;
  /**
   * Cloudflare `send_email` binding (Email Routing → MailChannels). Present in
   * production (wrangler.jsonc); absent in local dev/tests, where the mailer
   * factory falls back to DevMailer.
   */
  SEND_EMAIL?: import("@cloudflare/workers-types").SendEmail;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

type Auth = ReturnType<typeof createAuth>;
type SessionData = Auth["$Infer"]["Session"];

declare global {
  namespace App {
    interface Locals {
      /** Per-request Better Auth instance (bound to this request's D1). */
      auth: Auth;
      session: SessionData["session"] | null;
      user: SessionData["user"] | null;
    }
    interface Platform {
      env: CloudEnv;
      context: { waitUntil(promise: Promise<unknown>): void };
      caches: unknown;
      cf?: unknown;
    }
    // interface Error {}
    // interface PageData {}
    // interface PageState {}
  }
}

export {};
