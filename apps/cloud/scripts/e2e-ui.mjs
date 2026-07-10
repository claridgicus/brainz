#!/usr/bin/env node
/**
 * UI E2E (UI-wave owned; the backend journey lives in e2e.mjs): boots
 * `wrangler dev` on a scratch state dir and drives the real dashboard flow
 * over HTTP, asserting SSR HTML — no browser required.
 *
 * Flow: anon splash + auth redirects → signup via the Better Auth API
 * (session cookie) → empty dashboard → create vault + concepts via REST →
 * dashboard lists the vault → /v/[slug] SSR carries vault name, stats and
 * concept inventory (keyword-only badge asserted — no Workers AI locally) →
 * settings SSR shows keys/MCP/danger zone → unknown slug 404s.
 *
 * Run: node scripts/e2e-ui.mjs   (set E2E_UI_SKIP_BUILD=1 to reuse a build)
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.E2E_UI_PORT ?? 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = path.join(appDir, ".wrangler", "e2e-ui-state");

let passed = 0;
let failed = 0;

function step(name, ok, detail = "") {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed++;
  else {
    failed++;
    process.exitCode = 1;
  }
}

// --------------------------------------------------------------- http utils

const jar = new Map();

function storeCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

/** GET a page (no redirect following) and return { status, location, html }. */
async function page(pathname, { cookie = true } = {}) {
  const headers = {};
  if (cookie && jar.size > 0) headers.cookie = cookieHeader();
  const res = await fetch(`${BASE}${pathname}`, { headers, redirect: "manual" });
  storeCookies(res);
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
}

async function api(method, pathname, { body, cookie = true } = {}) {
  // Real browser-like Origin — Better Auth rejects undici's `Origin: null`.
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie && jar.size > 0) headers.cookie = cookieHeader();
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

// ------------------------------------------------------------------ wrangler

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: appDir, encoding: "utf8" });
  if (res.status !== 0) {
    console.error(res.stdout, res.stderr);
    throw new Error(`${cmd} ${args.join(" ")} failed (${res.status})`);
  }
}

async function waitForReady(proc) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`wrangler dev exited early (${proc.exitCode})`);
    try {
      const res = await fetch(`${BASE}/`, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not become ready within 60s");
}

// ----------------------------------------------------------------------- go

async function main() {
  console.log("== Brainz Cloud UI E2E ==");

  if (process.env.E2E_UI_SKIP_BUILD !== "1") {
    console.log("-- building app (vite build + DO patch)…");
    run("npm", ["run", "build"]);
  }

  rmSync(STATE_DIR, { recursive: true, force: true });
  console.log("-- applying D1 migrations to scratch state…");
  run("npx", ["wrangler", "d1", "migrations", "apply", "brainz", "--local", "--persist-to", STATE_DIR]);

  console.log(`-- starting wrangler dev on :${PORT}…`);
  const dev = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", STATE_DIR, "--show-interactive-dev-session=false"],
    { cwd: appDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let devLog = "";
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));

  try {
    await waitForReady(dev);
    console.log("-- wrangler dev ready\n");

    // 1. anonymous pages
    const splash = await page("/");
    step("anon / → 200 splash", splash.status === 200, `status ${splash.status}`);
    step("splash carries the wordmark + tagline", splash.html.includes("Brainz") && splash.html.includes("shared brain"));
    step("splash links to brownmatter.ai", splash.html.includes("https://brownmatter.ai"));
    step("splash has sign-in and sign-up CTAs", splash.html.includes("/login") && splash.html.includes("/signup"));

    const guarded = await page("/dashboard");
    step("anon /dashboard redirects to /login", guarded.status === 302, `status ${guarded.status}`);
    step(
      "guard preserves ?next=",
      (guarded.location ?? "").includes("/login?next=%2Fdashboard"),
      guarded.location ?? "(none)",
    );

    const login = await page("/login");
    step("anon /login → 200", login.status === 200 && login.html.includes("Sign in"));

    // 2. signup via the auth API → session cookie
    const email = `e2e-ui-${Date.now()}@example.com`;
    const signup = await api("POST", "/api/auth/sign-up/email", {
      body: { name: "UI E2E", email, password: "correct-horse-battery" },
    });
    step("signup returns 200 + cookie", signup.status === 200 && jar.size > 0, `status ${signup.status}`);

    // 3. signed-in redirects + empty dashboard
    const home = await page("/");
    step("signed-in / redirects to /dashboard", home.status === 302 && home.location === "/dashboard", `${home.status} → ${home.location}`);
    const loginAuthed = await page("/login");
    step("signed-in /login redirects away", loginAuthed.status === 302, `status ${loginAuthed.status}`);

    const emptyDash = await page("/dashboard");
    step("empty dashboard teaches", emptyDash.status === 200 && emptyDash.html.includes("Create your first vault"));

    // 4. create vault + concepts via REST
    const vaultRes = await api("POST", "/api/vaults", { body: { name: "UI Vault" } });
    step("create vault → 201", vaultRes.status === 201, `status ${vaultRes.status}`);
    const vault = vaultRes.json;
    step("vault slug derived", vault?.slug === "ui-vault", vault?.slug);

    const c1 = await api("POST", `/api/vaults/${vault.id}/concepts`, {
      body: {
        id: "auth-system",
        title: "Auth System",
        type: "feature",
        tags: ["auth"],
        body: "Sessions and tokens. See [[missing-note]].",
      },
    });
    const c2 = await api("POST", `/api/vaults/${vault.id}/concepts`, {
      body: {
        title: "User Model",
        type: "concept",
        body: "Canonical user record; credentials live in [[auth-system]].",
      },
    });
    step("create concepts → 201", c1.status === 201 && c2.status === 201, `${c1.status}/${c2.status}`);

    // 5. dashboard lists the vault
    const dash = await page("/dashboard");
    step("dashboard lists the vault", dash.status === 200 && dash.html.includes("UI Vault") && dash.html.includes("ui-vault"));

    // 6. vault workspace SSR
    const ws = await page("/v/ui-vault");
    step("/v/ui-vault → 200", ws.status === 200, `status ${ws.status}`);
    step("workspace SSR carries the vault name", ws.html.includes("UI Vault"));
    step("workspace SSR carries stats (2 concepts)", ws.html.includes("2 concepts"), "expected '2 concepts' in stats bar");
    step(
      "workspace SSR inventories concept titles",
      ws.html.includes("Auth System") && ws.html.includes("User Model"),
    );
    step("keyword-only badge shown (no Workers AI locally)", ws.html.includes("keyword-only"));
    step("pending edge target counted", ws.html.includes("1 pending"));

    // 7. settings SSR (+ a key created via REST shows up)
    const keyRes = await api("POST", `/api/vaults/${vault.id}/keys`, { body: { name: "ui-e2e-key" } });
    step("create key → 201 with bz_ plaintext", keyRes.status === 201 && keyRes.json?.key?.startsWith("bz_"), `status ${keyRes.status}`);

    const settings = await page("/v/ui-vault/settings");
    step("/v/ui-vault/settings → 200", settings.status === 200, `status ${settings.status}`);
    step("settings SSR has API keys + danger zone", settings.html.includes("API keys") && settings.html.includes("Danger zone"));
    step("settings lists the created key by name + prefix", settings.html.includes("ui-e2e-key") && settings.html.includes(keyRes.json.keyPrefix));
    step("settings shows the MCP setup snippets", settings.html.includes("https://brainz.brownmatter.ai/mcp") && settings.html.includes("claude mcp add"));
    step("settings teaches onboard as step 1", settings.html.includes("onboard"));

    // 8. unknown slug 404s
    const missing = await page("/v/never-created");
    step("/v/<unknown-slug> → 404", missing.status === 404, `status ${missing.status}`);
  } catch (err) {
    step("journey completed without exceptions", false, err instanceof Error ? err.message : String(err));
    if (devLog) console.error("\n---- wrangler dev log (tail) ----\n" + devLog.slice(-4000));
  } finally {
    dev.kill("SIGTERM");
  }

  console.log(`\n== UI E2E: ${passed} passed, ${failed} failed ==`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
