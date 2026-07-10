#!/usr/bin/env node
/**
 * `npm run dev`: full local dev with HMR.
 *
 * Starts two processes:
 *  1. wrangler dev on wrangler.do.jsonc — a sidecar Worker that hosts the
 *     VaultDO Durable Object (getPlatformProxy can't run same-worker DOs,
 *     but reaches this one through the local dev registry).
 *  2. vite dev — the SvelteKit app; bindings come from wrangler.dev.jsonc
 *     via the adapter's platformProxy (local D1 + the sidecar's VAULT_DO).
 *
 * Workers AI is not available in vite dev (remote-only binding); vaults run
 * keyword-only here. Use `npm run preview` (with `wrangler login`) to
 * exercise embeddings.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DO_PORT = process.env.BRAINZ_DO_PORT ?? "8790";

console.log(`[dev] starting VaultDO sidecar (wrangler dev -c wrangler.do.jsonc :${DO_PORT})…`);
const sidecar = spawn(
  "npx",
  ["wrangler", "dev", "-c", "wrangler.do.jsonc", "--port", DO_PORT, "--show-interactive-dev-session=false"],
  { cwd: appDir, stdio: ["ignore", "pipe", "pipe"] },
);
sidecar.stdout.on("data", (d) => process.stdout.write(`[do] ${d}`));
sidecar.stderr.on("data", (d) => process.stderr.write(`[do] ${d}`));

// Give the sidecar a head start so the dev registry entry exists.
await new Promise((r) => setTimeout(r, 3000));

console.log("[dev] starting vite dev…");
const vite = spawn("npx", ["vite", "dev", ...process.argv.slice(2)], {
  cwd: appDir,
  stdio: "inherit",
});

const stop = () => {
  sidecar.kill("SIGTERM");
  vite.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
vite.on("exit", (code) => {
  sidecar.kill("SIGTERM");
  process.exit(code ?? 0);
});
sidecar.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`[dev] VaultDO sidecar exited with ${code} — vault content routes will 500`);
  }
});
