/**
 * Better Auth, instantiated per request (Workers bindings are per-request).
 *
 * - email + password enabled (PBKDF2 via Web Crypto — see password.ts)
 * - GitHub OAuth only when GITHUB_CLIENT_ID/SECRET are both present
 * - drizzle adapter over the D1 control plane
 * - sveltekitCookies must be the LAST plugin (per Better Auth docs)
 *
 * Production: BETTER_AUTH_URL=https://brain.brownmatter.ai (wrangler secret).
 * Locally it may be unset — Better Auth then infers the base URL per request,
 * and both localhost origins are trusted.
 */
import { getRequestEvent } from "$app/server";
import type { CloudEnv } from "../../app.d";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sveltekitCookies } from "better-auth/svelte-kit";
import { createDb, schema } from "./db";
import { hashPassword, verifyPassword } from "./password";

export const PRODUCTION_ORIGIN = "https://brain.brownmatter.ai";

export function createAuth(env: CloudEnv) {
  const db = createDb(env.DB);
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : {};

  return betterAuth({
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    secret: env.BETTER_AUTH_SECRET ?? "dev-insecure-secret-change-me",
    trustedOrigins: [
      PRODUCTION_ORIGIN,
      // Local dev: vite dev (5173), wrangler dev (8787), E2E harness (8788).
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://localhost:8788",
      "http://127.0.0.1:8788",
      ...(env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : []),
    ],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    socialProviders: github,
    plugins: [sveltekitCookies(getRequestEvent)],
  });
}
