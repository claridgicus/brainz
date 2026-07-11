import { createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

/**
 * First paint gets the task pile + the graph (for concept titles / lane labels)
 * server-side; the board then polls GET /tasks client-side for real-time updates.
 */
export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  const [tasks, graph] = await Promise.all([api.listTasks(vault.id), api.graph(vault.id)]);
  return { tasks, graph };
};
