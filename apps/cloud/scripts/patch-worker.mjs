/**
 * Post-build step: append the VaultDO Durable Object export to the worker
 * adapter-cloudflare generated at .svelte-kit/cloudflare/_worker.js.
 *
 * adapter-cloudflare compiles the SvelteKit app into that file (wrangler's
 * `main`) but has no mechanism for named exports — and Durable Object
 * classes MUST be exported from the Worker entrypoint. The generated worker
 * is not yet bundled (wrangler bundles `main` with esbuild at dev/deploy
 * time), so appending a re-export of the TypeScript source works: esbuild
 * resolves and compiles it along with the rest.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerFile = fileURLToPath(new URL("../.svelte-kit/cloudflare/_worker.js", import.meta.url));
const MARKER = "// brainz-cloud: Durable Object exports (appended by scripts/patch-worker.mjs)";

const source = readFileSync(workerFile, "utf8");
if (source.includes(MARKER)) {
  console.log("[patch-worker] _worker.js already exports VaultDO");
} else {
  appendFileSync(
    workerFile,
    `\n${MARKER}\nexport { VaultDO } from "../../src/lib/server/vault-do.ts";\n`,
  );
  console.log("[patch-worker] appended VaultDO export to _worker.js");
}
