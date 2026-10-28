/**
 * PUT/DELETE /api/account/llm-key — session only: set, replace or remove the
 * caller's bring-your-own dream LLM key. The key is AES-GCM encrypted at rest
 * and never returned — responses carry only its hint.
 */
import { json } from "@sveltejs/kit";
import { llmKeyPutRequestSchema } from "@brainz/contracts";
import { accountDreaming, controlPlane } from "$lib/server/account-dreaming";
import { guarded, HttpError, parseBody, requirePlatform } from "$lib/server/api-util";
import { deleteLlmKey, saveLlmKey } from "$lib/server/dream-budget";
import { requireUser } from "$lib/server/vault-access";

export const PUT = guarded(async (event) => {
  const user = requireUser(event);
  const body = await parseBody(event, llmKeyPutRequestSchema);
  const env = requirePlatform(event).env;
  if (!env.BYOK_ENCRYPTION_KEY) {
    throw new HttpError(503, "bring-your-own keys are not configured on this server");
  }
  await saveLlmKey(controlPlane(env), env.BYOK_ENCRYPTION_KEY, user.id, body);
  return json(await accountDreaming(env, user.id));
});

export const DELETE = guarded(async (event) => {
  const user = requireUser(event);
  const env = requirePlatform(event).env;
  await deleteLlmKey(controlPlane(env), user.id);
  return json(await accountDreaming(env, user.id));
});
