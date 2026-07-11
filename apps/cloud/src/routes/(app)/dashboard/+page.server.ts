import { createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch }) => {
  const api = createApi(fetch);
  const vaults = await api.listVaults();
  // Per-vault open-task counts for the dashboard chips. Best-effort: a failing
  // stats call must not break the dashboard, so default to 0.
  const openTasks = Object.fromEntries(
    await Promise.all(
      vaults.map(async (v) => {
        try {
          const stats = await api.stats(v.id);
          return [v.id, stats.openTasks] as const;
        } catch {
          return [v.id, 0] as const;
        }
      }),
    ),
  );
  return { vaults, openTasks };
};
