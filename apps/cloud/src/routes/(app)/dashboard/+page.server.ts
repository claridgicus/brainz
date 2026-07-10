import { createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch }) => {
  const api = createApi(fetch);
  return { vaults: await api.listVaults() };
};
