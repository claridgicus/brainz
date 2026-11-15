import { createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

/**
 * First paint gets the task pile + the graph (for concept titles / lane labels)
 * server-side; the board then polls GET /tasks client-side for real-time updates.
 */
export const load: PageServerLoad = async ({ fetch, parent, url }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  const [tasks, graph] = await Promise.all([api.listTasks(vault.id), api.graph(vault.id)]);
  // `?group=epic|concept|priority|takenBy|status` picks the initial grouping
  // (the page ignores anything else), so other views can link to a grouped board.
  return { tasks, graph, group: url.searchParams.get("group") };
};
