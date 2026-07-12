import type { VaultInvite, VaultMember } from "@brainz/contracts";
import { createApi, roleOf } from "$lib/api";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { vault } = await parent();
  const api = createApi(fetch);
  const isOwner = roleOf(vault) === "owner";

  // Keys + invites + public status are owner-only surfaces (the API 404s them
  // for everyone else); members is visible to every member. Members/invites load
  // best-effort — `null` renders an inline error instead of a 500 page.
  const [keys, members, invites, publicStatus] = await Promise.all([
    isOwner ? api.listKeys(vault.id) : Promise.resolve([]),
    api.listMembers(vault.id).catch(() => null as VaultMember[] | null),
    isOwner
      ? api.listInvites(vault.id).catch(() => null as VaultInvite[] | null)
      : Promise.resolve([] as VaultInvite[]),
    isOwner
      ? api.getPublicStatus(vault.id).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { keys, members, invites, publicStatus };
};
