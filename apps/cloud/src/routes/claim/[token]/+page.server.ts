/**
 * Retired route. The old set-password claim flow is gone — auth is passwordless
 * (magic link). Any lingering /claim/<token> link now just sends the human to
 * the sign-in page, where entering their email gets them a magic link.
 */
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
  redirect(308, "/login");
};
