import { error } from "@sveltejs/kit";
import { createApi, vaultBySlug } from "$lib/api";
import type { LayoutServerLoad } from "./$types";

/** Map the URL slug to the vault (REST routes take the vault *id*). */
export const load: LayoutServerLoad = async ({ fetch, params }) => {
  const api = createApi(fetch);
  const vault = vaultBySlug(await api.listVaults(), params.slug);
  if (!vault) error(404, `No vault named "${params.slug}"`);
  return { vault };
};
