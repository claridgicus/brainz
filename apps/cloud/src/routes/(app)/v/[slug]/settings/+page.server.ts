import type { ConceptTypeEntry, VaultInvite, VaultMember } from "@brainz/contracts";
import { createApi, roleOf } from "$lib/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  const isOwner = roleOf(vault) === "owner";

  // Keys + invites are owner-only surfaces (the API 404s them for everyone
  // else); members is visible to every member. Members/invites load
  // best-effort — `null` renders an inline error instead of a 500 page.
  // Concept types are visible to every member (viewer+); best-effort so the
  // page still renders if the fetch hiccups.
  const [keys, members, invites, types] = await Promise.all([
    isOwner ? api.listKeys(vault.id) : Promise.resolve([]),
    api.listMembers(vault.id).catch(() => null as VaultMember[] | null),
    isOwner
      ? api.listInvites(vault.id).catch(() => null as VaultInvite[] | null)
      : Promise.resolve([] as VaultInvite[]),
    api.listTypes(vault.id).catch(() => null as ConceptTypeEntry[] | null),
  ]);
  return { keys, members, invites, types };
};
