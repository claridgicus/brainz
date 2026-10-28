/**
 * Post-build step: append the VaultDO Durable Object export, and the cron
 * `scheduled` handler, to the worker adapter-cloudflare generated at
 * .svelte-kit/cloudflare/_worker.js.
 *
 * adapter-cloudflare compiles the SvelteKit app into that file (wrangler's
 * `main`) but has no mechanism for named exports — and Durable Object
 * classes MUST be exported from the Worker entrypoint. The generated worker
 * is not yet bundled (wrangler bundles `main` with esbuild at dev/deploy
 * time), so appending a re-export of the TypeScript source works: esbuild
 * resolves and compiles it along with the rest. The adapter's default export
 * only has `fetch`, so `scheduled` (src/lib/server/scheduled.ts) is attached
 * to that object; the build fails if its name can't be found.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerFile = fileURLToPath(new URL("../.svelte-kit/cloudflare/_worker.js", import.meta.url));
const MARKER = "// brainz-cloud: Durable Object exports + cron handler (appended by scripts/patch-worker.mjs)";

const source = readFileSync(workerFile, "utf8");
if (source.includes(MARKER)) {
  console.log("[patch-worker] _worker.js already exports VaultDO + scheduled");
} else {
  // adapter-cloudflare ends the file with `export { worker_default as default };`.
  const defaultName = /export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}/.exec(source)?.[1];
  if (!defaultName) {
    console.error("[patch-worker] can't find the default export in _worker.js; cron handler not attached");
    process.exit(1);
  }
  appendFileSync(
    workerFile,
    `\n${MARKER}\nexport { VaultDO } from "../../src/lib/server/vault-do.ts";\n` +
      `import { scheduled as __brainzScheduled } from "../../src/lib/server/scheduled.ts";\n` +
      `${defaultName}.scheduled = __brainzScheduled;\n`,
  );
  console.log(`[patch-worker] appended VaultDO export and ${defaultName}.scheduled to _worker.js`);
}
