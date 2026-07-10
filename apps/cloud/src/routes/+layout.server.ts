import type { LayoutServerLoad } from "./$types";

/** Expose the session to every page; the UI wave builds on `data.user`/`data.session`. */
export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    user: locals.user ?? null,
    session: locals.session ?? null,
  };
};
