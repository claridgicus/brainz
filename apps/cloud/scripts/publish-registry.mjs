/**
 * Post-deploy MCP Registry publication (runs at the end of `npm run deploy`).
 *
 * Keeps registry.modelcontextprotocol.io in sync with server.json, idempotently:
 *   1. Reads server.json (the registry publish artifact — name + version).
 *   2. Asks the live registry whether that exact version is already published;
 *      if so, exits 0 silently-ish (the common case on every redeploy).
 *   3. Otherwise runs `mcp-publisher publish server.json`. A missing CLI or
 *      missing login (the one-time DNS/HTTP domain verification — see the
 *      "MCP discovery & registry publication" section of README.md) prints an
 *      UNMISSABLE warning but exits 0: the Worker deploy above already
 *      succeeded, and a registry hiccup must not mark it failed.
 *      Set MCP_PUBLISH_STRICT=1 (e.g. in CI) to exit 1 instead.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.modelcontextprotocol.io";

const { name, version } = JSON.parse(readFileSync(join(appRoot, "server.json"), "utf8"));

/** Recursively collect `version` values of any object whose `name` matches ours. */
function versionsOf(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => versionsOf(n, out));
  else if (node && typeof node === "object") {
    if (node.name === name && typeof node.version === "string") out.push(node.version);
    Object.values(node).forEach((v) => versionsOf(v, out));
  }
  return out;
}

async function publishedVersions() {
  const res = await fetch(`${REGISTRY}/v0/servers?search=${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  return versionsOf(await res.json());
}

function warnAndExit(lines) {
  const strict = process.env.MCP_PUBLISH_STRICT === "1";
  console.warn(
    [
      "",
      "┌─ MCP Registry publish SKIPPED ─────────────────────────────────",
      ...lines.map((l) => `│ ${l}`),
      `│ Manual publish: cd apps/cloud && mcp-publisher publish server.json`,
      "└─────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
  process.exit(strict ? 1 : 0);
}

let versions = [];
try {
  versions = await publishedVersions();
} catch (err) {
  warnAndExit([
    `could not reach the registry to compare versions (${err instanceof Error ? err.message : err}).`,
  ]);
}

if (versions.includes(version)) {
  console.log(`[registry] ${name}@${version} already published — up to date.`);
  process.exit(0);
}

console.log(
  `[registry] ${name}@${version} not on the registry (found: ${versions.join(", ") || "none"}) — publishing…`,
);

const probe = spawnSync("mcp-publisher", ["--help"], { stdio: "ignore" });
if (probe.error) {
  warnAndExit([
    `server.json is at version ${version} but mcp-publisher is not installed.`,
    "Install: brew install mcp-publisher (one-time domain login: README.md",
    '"MCP discovery & registry publication").',
  ]);
}

const publish = spawnSync("mcp-publisher", ["publish", "server.json"], {
  cwd: appRoot,
  stdio: "inherit",
});
if (publish.status !== 0) {
  warnAndExit([
    `mcp-publisher publish failed (exit ${publish.status}) — most likely the`,
    "one-time `mcp-publisher login dns --domain=brownmatter.ai` has not been",
    "run on this machine (see README.md).",
  ]);
}

console.log(`[registry] published ${name}@${version}.`);
