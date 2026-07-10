import { building } from "$app/environment";
import type { Handle } from "@sveltejs/kit";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { createAuth } from "$lib/server/auth";

export const handle: Handle = async ({ event, resolve }) => {
  if (building || !event.platform?.env) {
    // Prerender/build: no Cloudflare bindings to wire up.
    return resolve(event);
  }

  const auth = createAuth(event.platform.env);
  event.locals.auth = auth;
  event.locals.session = null;
  event.locals.user = null;

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
