/**
 * The signed-in user's dreaming account view (GET /api/account/dreaming and the
 * llm-key PUT/DELETE responses): which provider their dreams run on, the
 * stored key's hint (never the plaintext), today's spend vs the cap, and the
 * kill switch.
 */
import type { AccountDreaming, LlmKeyInfo } from "@brainz/contracts";
import type { CloudEnv } from "../../app.d";
import {
  chooseDreamProvider,
  dailyCapUsd,
  type D1Like,
  loadLlmKey,
  spendSummary,
  utcDay,
} from "./dream-budget";

export function controlPlane(env: CloudEnv): D1Like {
  return env.DB as unknown as D1Like;
}

export async function accountDreaming(env: CloudEnv, userId: string): Promise<AccountDreaming> {
  const db = controlPlane(env);
  const [choice, row] = await Promise.all([
    chooseDreamProvider({ db, env, ai: env.AI as never, ownerId: userId }),
    loadLlmKey(db, userId),
  ]);
  const key: LlmKeyInfo | null = row
    ? {
        provider: row.provider === "openai" ? "openai" : "anthropic",
        hint: row.key_hint,
        baseUrl: row.base_url,
        model: row.model,
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
      }
    : null;
  return {
    provider: choice.provider,
    key,
    spend: choice.spend ?? spendSummary(utcDay(new Date()), 0, dailyCapUsd(env)),
    killSwitch: choice.killSwitch,
  };
}
