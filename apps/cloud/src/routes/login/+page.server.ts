import { redirect } from "@sveltejs/kit";
import { safeNextPath } from "$lib/nav";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url, platform }) => {
  if (locals.user) redirect(302, safeNextPath(url.searchParams.get("next")));
  // GitHub button only when the backend actually has the provider configured.
  return {
    github: Boolean(platform?.env.GITHUB_CLIENT_ID && platform.env.GITHUB_CLIENT_SECRET),
  };
};
