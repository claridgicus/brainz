import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

/** Session guard for the whole (app) group: anonymous visitors go to /login
 * and come back to where they were headed via ?next=. */
export const load: LayoutServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    redirect(302, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  return { user: locals.user };
};
