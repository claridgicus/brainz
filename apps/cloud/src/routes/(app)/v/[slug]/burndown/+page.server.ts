import { ApiError, createApi } from "$lib/api";
import type { PageServerLoad } from "./$types";

/**
 * First paint: the vault's concepts (for the scope picker and the
 * iteration/milestone list) and the burndown for `?scope=&unit=`. The page
 * then polls GET /burndown client-side.
 */
export const load: PageServerLoad = async ({ fetch, parent, url }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  const scope = url.searchParams.get("scope") ?? "";
  const unit = url.searchParams.get("unit") === "points" ? "points" : "tasks";
  const concepts = await api.listConcepts(vault.id);
  let burndown = null;
  let error: string | null = null;
  try {
    burndown = await api.burndown(vault.id, { scope: scope || undefined, unit });
  } catch (err) {
    error = err instanceof ApiError ? err.message : "Could not load the burndown.";
  }
  return { concepts: concepts.concepts, burndown, scope, unit, error };
};
