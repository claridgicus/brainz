// Ambient types for the SvelteKit app (backend-owned; see SPEC-CLOUD.md).
// The workerd-only `cloudflare:email` module is declared in
// src/cloudflare-email.d.ts (a script-scope ambient file so the module
// declaration is global).
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
  /** Dreaming: USD per account per UTC day for operator-paid (Workers AI) dreams. Default 1. */
  DREAM_DAILY_USD_PER_ACCOUNT?: string;
  /** Dreaming kill-switch override: `1`/`true`/`workers-ai` or `all` (see README). */
  DREAMING_AI_DISABLED?: string;
  /** Secret the AES-GCM key for stored BYOK dream LLM keys is derived from. */
  BYOK_ENCRYPTION_KEY?: string;
  /** OAuth refresh-reuse grace window in seconds (default 60; the E2E shortens it). */
  OAUTH_REFRESH_GRACE_SECONDS?: string;
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
