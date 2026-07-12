/**
 * Anonymous PUBLIC vault view (public vaults) — no session required. Resolve the
 * `[token]` to its public vault (unknown/rotated/revoked/disabled → 404, keeping
 * the non-enumeration discipline) and server-render the graph + stats for a
 * flash-free first paint. Only the vault NAME, graph, and stats cross the wire —
 * never the owner, members, keys, or invites.
 */
import { error } from "@sveltejs/kit";
import { requirePlatform } from "$lib/server/api-util";
import { createDb } from "$lib/server/db";
import { resolvePublicVault } from "$lib/server/public-vault";
import { vaultClient } from "$lib/server/vault-client";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async (event) => {
  const platform = requirePlatform(event);
  const db = createDb(platform.env.DB);
  const vault = await resolvePublicVault(db, event.params.token);
  // 404 (never 403) — a valid-but-not-public token reads like a made-up one.
  if (!vault) error(404, "This page isn't available.");

  const client = vaultClient(platform.env.VAULT_DO, vault.id);
  const [graph, stats] = await Promise.all([client.graph(), client.stats()]);
  const { keywordIndex, ...statsWire } = stats;
  return {
    token: event.params.token,
    // Only the display name is exposed — no id, owner, slug, or membership.
    vaultName: vault.name,
    graph,
    stats: { ...statsWire, keywordIndex },
  };
};
