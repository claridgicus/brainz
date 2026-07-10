import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/** Signed-in users land on the dashboard; everyone else gets the splash. */
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) redirect(302, "/dashboard");
};
