/**
 * The Worker's `scheduled` handler (cron triggers in wrangler.jsonc).
 * adapter-cloudflare only emits `fetch`, so scripts/patch-worker.mjs attaches
 * this to the generated default export. Today it runs the daily OAuth purge.
 */
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import type { CloudEnv } from "../../app.d";
import { purgeExpiredOAuthState } from "./oauth";

export async function scheduled(
  controller: ScheduledController,
  env: Pick<CloudEnv, "DB">,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(
    purgeExpiredOAuthState(env.DB, new Date(controller.scheduledTime)).catch((err: unknown) => {
      console.error("[scheduled] OAuth purge failed", err);
    }),
  );
}
