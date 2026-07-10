import { createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  return { keys: await api.listKeys(vault.id) };
};
