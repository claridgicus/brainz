import { createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

/**
 * First paint gets the board's two payloads, the task pile and the concept
 * graph; the tree is derived from them client-side ($lib/feature-tree) and
 * kept live by polling, like the board.
 */
export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  const [tasks, graph] = await Promise.all([api.listTasks(vault.id), api.graph(vault.id)]);
  return { tasks, graph };
};
