/**
 * GET/PATCH /api/vaults/:vaultId/dreaming — the vault's dreaming settings.
 * GET: dream status (incl. every per-vault setting) + the 10 newest Dream
 * Diary entries — any member (viewer+) or bearer key.
 * PATCH: change settings (dreamSettingsPatchSchema; nested objects merge) —
 * editor+. See SPEC-CLOUD "Dreaming → Per-vault settings".
 */
import { json } from "@sveltejs/kit";
import { dreamSettingsPatchSchema, type VaultDreaming } from "@brainz/contracts";
import { guarded, parseBody, requirePlatform } from "$lib/server/api-util";
import { requireVaultAccess } from "$lib/server/vault-access";
import { vaultClient, type VaultClient } from "$lib/server/vault-client";

async function snapshot(client: VaultClient): Promise<VaultDreaming> {
  const [status, diary] = await Promise.all([client.dreamStatus(), client.dreamDiary(10)]);
  return { status, entries: diary.entries };
}

export const GET = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!);
  return json(await snapshot(vaultClient(requirePlatform(event).env.VAULT_DO, vault.id)));
});

export const PATCH = guarded(async (event) => {
  const { vault } = await requireVaultAccess(event, event.params.vaultId!, { role: "editor" });
  const patch = await parseBody(event, dreamSettingsPatchSchema);
  const client = vaultClient(requirePlatform(event).env.VAULT_DO, vault.id);
  await client.dreamConfigure(patch);
  return json(await snapshot(client));
});
