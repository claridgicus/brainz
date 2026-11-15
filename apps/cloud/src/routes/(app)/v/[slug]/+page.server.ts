import { createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

/**
 * First paint gets the graph + stats server-side (no client loading flash).
 * `?focus=<concept id>` (the feature tree's "Open in graph") opens the
 * workspace with that concept selected, focused and centred.
 */
export const load: PageServerLoad = async ({ fetch, parent, url }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  const [graph, stats] = await Promise.all([api.graph(vault.id), api.stats(vault.id)]);
  return { graph, stats, focus: url.searchParams.get("focus") };
};
