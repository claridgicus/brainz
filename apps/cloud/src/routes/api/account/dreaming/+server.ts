/**
 * GET /api/account/dreaming — session only: the caller's dream provider,
 * stored LLM key hint, today's operator-paid spend vs the daily cap, and the
 * kill switch. See SPEC-CLOUD "Dreaming → Spend controls".
 */
import { json } from "@sveltejs/kit";
import { accountDreaming } from "$lib/server/account-dreaming";
import { guarded, requirePlatform } from "$lib/server/api-util";
import { requireUser } from "$lib/server/vault-access";

export const GET = guarded(async (event) => {
  const user = requireUser(event);
  return json(await accountDreaming(requirePlatform(event).env, user.id));
});
