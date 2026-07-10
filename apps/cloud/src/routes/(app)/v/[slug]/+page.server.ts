import { createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

/** First paint gets the graph + stats server-side (no client loading flash). */
export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  const [graph, stats] = await Promise.all([api.graph(vault.id), api.stats(vault.id)]);
  return { graph, stats };
};
