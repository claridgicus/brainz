/**
 * The Worker's `scheduled` handler (cron triggers in wrangler.jsonc).
 * adapter-cloudflare only emits `fetch`, so scripts/patch-worker.mjs attaches
 * this to the generated default export. Today it runs the daily OAuth purge
 * and the support-inbox retention purge (raw MIME kept in D1).
 */
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import type { CloudEnv } from "../../app.d";
import { purgeExpiredOAuthState } from "./oauth";
import { purgeSupportMail } from "./support-email";

export async function scheduled(
  controller: ScheduledController,
  env: Pick<CloudEnv, "DB">,
  ctx: ExecutionContext,
): Promise<void> {
  const now = new Date(controller.scheduledTime);
  ctx.waitUntil(
    purgeExpiredOAuthState(env.DB, now).catch((err: unknown) => {
      console.error("[scheduled] OAuth purge failed", err);
    }),
  );
  ctx.waitUntil(
    purgeSupportMail(env.DB, now).catch((err: unknown) => {
      console.error("[scheduled] support mail purge failed", err);
    }),
  );
}
