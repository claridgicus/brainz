/**
 * Dev-only sidecar Worker that HOSTS VaultDO for `vite dev`.
 *
 * getPlatformProxy (vite dev's binding emulator) cannot run Durable Objects
 * defined in the same Worker, but it CAN bind to a DO hosted by another
 * local `wrangler dev` session through the dev registry — fetch-based stubs
 * only, which is exactly what vault-client.ts uses. scripts/dev.mjs runs
 * this Worker (wrangler.do.jsonc) alongside vite dev; wrangler.dev.jsonc
 * binds VAULT_DO to it via script_name.
 *
 * Production never uses this file: the deployed Worker exports VaultDO
 * itself (scripts/patch-worker.mjs).
 */
export { VaultDO } from "./lib/server/vault-do";

export default {
  async fetch(): Promise<Response> {
    return new Response("brainz-cloud-do: Durable Object host for vite dev", { status: 200 });
  },
};
