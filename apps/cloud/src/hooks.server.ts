import { building } from "$app/environment";
import type { Handle } from "@sveltejs/kit";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { createAuth, isProductionEnv } from "$lib/server/auth";
import { createDb } from "$lib/server/db";
import {
  guardDepsFromDb,
  guardMagicLinkRequest,
  MAGIC_LINK_REQUEST_PATH,
  throttleResponse,
} from "$lib/server/magic-link-guard";
import { isCrossSiteFormPost } from "$lib/server/oauth";
import { resolveRateLimitIp } from "$lib/server/rate-limit";

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
  // CSRF: SvelteKit's built-in cross-site form-POST check is switched off in
  // svelte.config.js (it can't exempt the OAuth token/revoke endpoints), so
  // the same rule is enforced here for every other path.
  if (isCrossSiteFormPost(event.request, event.url)) {
    return new Response(`Cross-site ${event.request.method} form submissions are forbidden`, {
      status: 403,
    });
  }

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
      // Fail closed on a missing cf-connecting-ip in production (audit LOW):
      // header-less traffic must not share one permissive "local" bucket that a
      // single actor could exhaust to DoS every other header-less client.
      const resolvedIp = resolveRateLimitIp(
        event.request.headers.get("cf-connecting-ip"),
        isProductionEnv(event.platform.env),
      );
      if (!resolvedIp.ok) return throttleResponse();
      const { throttled } = await guardMagicLinkRequest(
        guardDepsFromDb(createDb(event.platform.env.DB)),
        { email, ip: resolvedIp.ip },
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
