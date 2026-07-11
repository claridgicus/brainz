import type { PageServerLoad } from "./$types";

/**
 * Public page (no session) that renders the self-onboard skill prompt.
 * The canonical file is `static/skill.md` (served at /skill.md); we fetch it
 * through the load `fetch` so dev/preview/prod all resolve the same way.
 * If it's missing (e.g. not authored yet in dev) the page shows a graceful
 * "coming soon" state instead of erroring.
 */
export const load: PageServerLoad = async ({ fetch }) => {
  try {
    const res = await fetch("/skill.md");
    if (!res.ok) return { markdown: null };
    return { markdown: await res.text() };
  } catch {
    return { markdown: null };
  }
};
