import { building } from "$app/environment";
import type { Handle } from "@sveltejs/kit";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { createAuth } from "$lib/server/auth";
import { createDb } from "$lib/server/db";
import {
  guardDepsFromDb,
  guardMagicLinkRequest,
  MAGIC_LINK_REQUEST_PATH,
  throttleResponse,
} from "$lib/server/magic-link-guard";

/** Extract the email from a magic-link request body without consuming it. */
async function readMagicLinkEmail(request: Request): Promise<string | null> {
  try {
    const body = (await request.clone().json()) as { email?: unknown };
    return typeof body.email === "string" ? body.email : null;
  } catch {
    return null;
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  if (building || !event.platform?.env) {
    // Prerender/build: no Cloudflare bindings to wire up.
    return resolve(event);
  }

  const auth = createAuth(event.platform.env);
  event.locals.auth = auth;
  event.locals.session = null;
  event.locals.user = null;

  // Durable (D1-backed) rate limit on the magic-link request path — survives
  // per-request Worker instances (Better Auth's in-memory limiter does not).
  if (event.request.method === "POST" && event.url.pathname === MAGIC_LINK_REQUEST_PATH) {
    const email = await readMagicLinkEmail(event.request);
    if (email) {
      const ip = event.request.headers.get("cf-connecting-ip") ?? "local";
      const { throttled } = await guardMagicLinkRequest(
        guardDepsFromDb(createDb(event.platform.env.DB)),
        { email, ip },
      );
      if (throttled) return throttleResponse();
    }
  }

  // Resolve the cookie session (skip when there are no cookies at all —
  // e.g. bearer-authenticated API/MCP calls).
  if (event.request.headers.get("cookie")) {
    const session = await auth.api.getSession({ headers: event.request.headers });
    if (session) {
      event.locals.session = session.session;
      event.locals.user = session.user;
    }
  }

  return svelteKitHandler({ event, resolve, auth, building });
};
