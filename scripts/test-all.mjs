#!/usr/bin/env node
/**
 * test-all — THE pre-deploy gate for the Brainz monorepo.
 *
 * `npm run test:all` (repo root) runs, in order:
 *   1. typecheck        — tsc/svelte-check across every workspace
 *   2. unit tests       — vitest for packages/* and apps/cloud
 *   3. svelte-check     — apps/cloud + apps/marketing `check` scripts
 *   4. build            — every workspace (cloud: vite build + DO patch)
 *   5. marketing check  — scripts/check-build.mjs over the fresh build
 *   6. cloud E2E        — full backend journey vs wrangler dev (scripts/e2e.mjs)
 *   7. cloud UI E2E     — SSR dashboard journey vs wrangler dev (scripts/e2e-ui.mjs)
 *
 * Any failing step exits non-zero and prints a summary. Steps run fail-fast:
 * later steps are reported as "skipped".
 *
 * `--scope marketing` runs the marketing-only subset (check, build,
 * check-build) — used by apps/marketing's predeploy hook.
 *
 * E2E prerequisites are handled here and inside the e2e scripts themselves:
 * both apply D1 migrations to a scratch --persist-to dir and boot their own
 * `wrangler dev --local`. If apps/cloud/.dev.vars is missing, a minimal one
 * is written (BETTER_AUTH_SECRET only — deliberately NO BETTER_AUTH_URL line,
 * so Better Auth infers the base URL from the wrangler-dev origin). An
 * existing .dev.vars is left untouched.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cloudDir = path.join(root, "apps", "cloud");
const scope = process.argv.includes("--scope")
  ? process.argv[process.argv.indexOf("--scope") + 1]
  : "all";

/** @type {{name: string, cmd: string, args: string[], cwd?: string, env?: Record<string,string>}[]} */
const FULL_STEPS = [
  {
    name: "typecheck (all workspaces)",
    cmd: "npm",
    args: ["run", "typecheck", "--workspaces", "--if-present"],
  },
  {
    name: "unit tests (packages/* + apps/cloud)",
    cmd: "npm",
    args: [
      "test",
      // Everything except brainz-marketing, whose `test` is a post-build
      // check — it runs as its own step after the build.
      "-w", "@brainz/engine",
      "-w", "@brainz/contracts",
      "-w", "@brainz/core",
      "-w", "@brainz/mcp-server",
      "-w", "@brainz/cli",
      "-w", "@brainz/web",
      "-w", "@brainz/cloud",
    ],
  },
  {
    // apps/cloud's svelte-check already ran in step 1 (its `typecheck` IS
    // `svelte-kit sync && svelte-check`); marketing's check only lives here.
    name: "svelte-check (apps/marketing; cloud's ran in typecheck)",
    cmd: "npm",
    args: ["run", "check", "-w", "brainz-marketing"],
  },
  {
    name: "build (all workspaces)",
    cmd: "npm",
    args: ["run", "build", "--workspaces", "--if-present"],
  },
  {
    name: "marketing check-build (post-build E2E-ish assertions)",
    cmd: "npm",
    args: ["test", "-w", "brainz-marketing"],
  },
  {
    name: "cloud backend E2E (wrangler dev journey)",
    cmd: "npm",
    args: ["run", "e2e", "-w", "@brainz/cloud"],
  },
  {
    name: "cloud UI E2E (SSR journey)",
    cmd: "node",
    args: ["scripts/e2e-ui.mjs"],
    cwd: cloudDir,
    // The build step above already produced .svelte-kit/cloudflare/_worker.js.
    env: { E2E_UI_SKIP_BUILD: "1" },
  },
];

const MARKETING_STEPS = [
  {
    name: "marketing svelte-check",
    cmd: "npm",
    args: ["run", "check", "-w", "brainz-marketing"],
  },
  {
    name: "marketing build",
    cmd: "npm",
    args: ["run", "build", "-w", "brainz-marketing"],
  },
  {
    name: "marketing check-build",
    cmd: "npm",
    args: ["test", "-w", "brainz-marketing"],
  },
];

function ensureDevVars() {
  const devVars = path.join(cloudDir, ".dev.vars");
  if (existsSync(devVars)) return "existing apps/cloud/.dev.vars left untouched";
  // Minimal E2E-safe vars: a secret, and deliberately NO BETTER_AUTH_URL —
  // Better Auth then infers the base URL from each request's origin, which
  // is what the ephemeral wrangler-dev ports need.
  writeFileSync(
    devVars,
    "# Written by scripts/test-all.mjs (gate run) — see .dev.vars.example.\n" +
      "BETTER_AUTH_SECRET=dev-insecure-secret-change-me\n",
  );
  return "wrote minimal apps/cloud/.dev.vars (BETTER_AUTH_SECRET only)";
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const steps = scope === "marketing" ? MARKETING_STEPS : FULL_STEPS;
console.log(`== Brainz test:all gate (scope: ${scope}) — ${steps.length} steps ==\n`);
if (scope !== "marketing") console.log(`-- ${ensureDevVars()}\n`);

const results = [];
let failedStep = null;

for (const step of steps) {
  if (failedStep) {
    results.push({ name: step.name, status: "skipped", ms: 0 });
    continue;
  }
  console.log(`\n──── ${step.name} ────`);
  const startedAt = Date.now();
  const res = spawnSync(step.cmd, step.args, {
    cwd: step.cwd ?? root,
    stdio: "inherit",
    env: { ...process.env, ...(step.env ?? {}) },
  });
  const ms = Date.now() - startedAt;
  const ok = res.status === 0;
  results.push({ name: step.name, status: ok ? "pass" : "FAIL", ms });
  if (!ok) failedStep = step.name;
}

console.log("\n== test:all summary ==");
for (const r of results) {
  const mark = r.status === "pass" ? "✓" : r.status === "FAIL" ? "✗" : "-";
  console.log(`  ${mark} ${r.status.padEnd(7)} ${r.name}${r.ms ? ` (${fmt(r.ms)})` : ""}`);
}

if (failedStep) {
  console.error(`\ntest:all FAILED at: ${failedStep}`);
  console.error("Deploys are blocked until the gate is green.");
  process.exit(1);
}
console.log("\ntest:all PASSED — safe to deploy.");
