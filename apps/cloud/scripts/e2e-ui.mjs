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
 * settings SSR shows keys/MCP/danger zone → unknown slug 404s → the OAuth
 * consent page with more than 5 vaults (search-and-select markup, "+ New
 * vault" above Allow, a duplicate approve getting the same code). When
 * `agent-browser` is on PATH (E2E_UI_BROWSER=0 skips it) a real browser also
 * drives the consent search, chips and a double-clicked Allow, which must
 * reach the client's callback exactly once.
 *
 * Run: node scripts/e2e-ui.mjs   (set E2E_UI_SKIP_BUILD=1 to reuse a build)
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
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

function storeCookies(res, target = jar) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) target.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
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

// ------------------------------------------------------------------ consent

/** A loopback "client" that records every OAuth callback it receives. */
async function callbackServer() {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // Only the OAuth callback counts (the browser also asks for /favicon.ico).
    if (url.pathname === "/callback") hits.push(url);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("callback received");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { hits, port: server.address().port, close: () => server.close() };
}

function agentBrowser(args) {
  const res = spawnSync("agent-browser", ["--session", "brainz-e2e-ui", ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`agent-browser ${args[0]} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function hasAgentBrowser() {
  if (process.env.E2E_UI_BROWSER === "0") return false;
  return spawnSync("agent-browser", ["--version"], { encoding: "utf8" }).status === 0;
}

async function consentJourney() {
  // Six more vaults (seven in all) puts the consent page in search mode.
  for (let i = 1; i <= 6; i++) {
    await api("POST", "/api/vaults", { body: { name: `Consent ${i}`, slug: `consent-${i}` } });
  }
  const listed = (await api("GET", "/api/vaults")).json?.vaults ?? [];
  step("seeded 7 vaults for the consent picker", listed.length === 7, `${listed.length} vaults`);
  const byslug = Object.fromEntries(listed.map((v) => [v.slug, v.id]));

  const reg = await api("POST", "/oauth/register", {
    cookie: false,
    body: { client_name: "E2E UI app", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" },
  });
  step("DCR registers a loopback client → 201", reg.status === 201, `status ${reg.status}`);
  const clientId = reg.json?.client_id;
  const callbacks = await callbackServer();
  const verifier = `ui-verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const redirectUri = `http://127.0.0.1:${callbacks.port}/callback`;
  const authorizeQs = (state) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "vault",
    });

  try {
    const consent = await page(`/oauth/authorize?${authorizeQs("ui-http")}`);
    const html = consent.html;
    step("consent page → 200", consent.status === 200, `status ${consent.status}`);
    step(
      "more than 5 vaults: search-and-select over the checkboxes (search hidden until hydrated)",
      html.includes('data-picker="search"') && /<div class="search[^"]*"[^>]*hidden/.test(html) &&
        html.includes('id="vault-search"') && (html.match(/name="vault_id"/g) ?? []).length === 7,
      `${(html.match(/name="vault_id"/g) ?? []).length} vault checkboxes`,
    );
    step("scope copy reflects multi-select", html.includes("the vaults you pick") && !html.includes("the vault you pick"));
    const iPicker = html.indexOf('id="vault-options"');
    const iNew = html.indexOf('action="?/createVault"');
    const iAllow = html.indexOf('form="consent-approve"');
    const iCancel = html.indexOf('action="?/deny"');
    step(
      "order: picker, + New vault, Allow access, Cancel",
      iPicker > 0 && iPicker < iNew && iNew < iAllow && iAllow < iCancel,
      `${iPicker} < ${iNew} < ${iAllow} < ${iCancel}`,
    );
    step("+ New vault input uses the design-system input", /<input[^>]*id="new-vault-name"[^>]*class="input/.test(html) || /<input[^>]*class="input[^"]*"[^>]*id="new-vault-name"/.test(html));

    // Server-side idempotency: two concurrent approves of one request, with
    // different selections, both 303 with ONE code.
    const approve = (state, ids) => {
      const form = authorizeQs(state);
      for (const id of ids) form.append("vault_id", id);
      return fetch(`${BASE}/oauth/authorize?/approve`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: BASE, cookie: cookieHeader() },
        body: form.toString(),
      });
    };
    const [a, b] = await Promise.all([approve("ui-http", [byslug["consent-1"]]), approve("ui-http", [byslug["consent-1"], byslug["consent-2"]])]);
    const codeOf = (r) => new URL(r.headers.get("location") ?? "http://x.invalid/").searchParams.get("code");
    step(
      "two concurrent approves of one request → the same code",
      a.status === 303 && b.status === 303 && Boolean(codeOf(a)) && codeOf(a) === codeOf(b),
      `${a.status}/${b.status}`,
    );

    if (!hasAgentBrowser()) {
      console.log("  [SKIP] browser consent checks (agent-browser not on PATH, or E2E_UI_BROWSER=0)");
      return;
    }
    const base = new URL(BASE);
    for (const [name, value] of jar) agentBrowser(["cookies", "set", name, value, "--url", `${base.origin}/`]);
    agentBrowser(["set", "viewport", "480", "1100"]);
    agentBrowser(["open", `${BASE}/oauth/authorize?${authorizeQs("ui-browser")}`]);
    // The search box is server-rendered hidden; it shows once the page hydrates.
    agentBrowser(["wait", ".search:not([hidden]) #vault-search"]);
    const visibleRows = () => Number(agentBrowser(["eval", `document.querySelectorAll("#vault-options .vault:not([hidden])").length`]));
    const chips = () => agentBrowser(["eval", `[...document.querySelectorAll(".chip")].map((c) => c.getAttribute("aria-label")).join("|")`]).replace(/^"|"$/g, "");
    step("browser: the search box shows once hydrated", agentBrowser(["is", "visible", "#vault-search"]).includes("true"));
    agentBrowser(["fill", "#vault-search", "consent-4"]);
    step("browser: searching by slug narrows the list to one vault", visibleRows() === 1, `${visibleRows()} visible`);
    agentBrowser(["press", "Enter"]);
    step(
      "browser: Enter ticks the match (chip added) without submitting",
      chips().includes("Remove Consent 4") && callbacks.hits.length === 0,
      chips(),
    );
    step("browser: the search clears after picking", visibleRows() === 7, `${visibleRows()} visible`);
    agentBrowser(["click", '[aria-label="Remove Consent 1"]']);
    step("browser: a chip's remove button unticks that vault", chips() === "Remove Consent 4", chips());
    agentBrowser(["check", 'input[name="all_vaults"]']);
    step(
      "browser: 'All my vaults' disables the picker and says so",
      agentBrowser(["is", "enabled", "#vault-search"]).includes("false") &&
        agentBrowser(["get", "text", "#vault-picker-status"]).includes("picking single vaults is off"),
    );
    agentBrowser(["uncheck", 'input[name="all_vaults"]']);
    if (process.env.E2E_UI_SCREENSHOT) agentBrowser(["screenshot", "--full", process.env.E2E_UI_SCREENSHOT]);

    // A double-clicked Allow reaches the client once, with the picked vault.
    // Count the submits the browser actually sends (not cancelled by the
    // page's guard). A window listener runs after the form's own handler; the
    // count lives in this origin's localStorage, so it outlives the redirect.
    agentBrowser([
      "eval",
      `localStorage.setItem("e2eSubmits", "0"); addEventListener("submit", (e) => { if (!e.defaultPrevented) localStorage.setItem("e2eSubmits", String(Number(localStorage.getItem("e2eSubmits")) + 1)); }); 1`,
    ]);
    agentBrowser(["dblclick", 'button[form="consent-approve"]']);
    const deadline = Date.now() + 10_000;
    while (callbacks.hits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500));
    step(
      "browser: a double-clicked Allow reaches the callback exactly once",
      callbacks.hits.length === 1,
      callbacks.hits.map((u) => u.pathname + u.search.slice(0, 20)).join(" | "),
    );
    agentBrowser(["open", `${BASE}/`]);
    const sent = agentBrowser(["eval", `localStorage.getItem("e2eSubmits")`]).replace(/"/g, "");
    step("browser: the double click submitted the approve form once", sent === "1", `${sent} submit(s) sent`);
    const code = callbacks.hits[0]?.searchParams.get("code");
    const token = await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: code ?? "", code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId }).toString(),
    });
    step("browser: that code exchanges for tokens", token.status === 200, `status ${token.status}`);
  } finally {
    callbacks.close();
    if (hasAgentBrowser()) spawnSync("agent-browser", ["--session", "brainz-e2e-ui", "close"]);
  }
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

  // Sign `email` in the passwordless way: request a magic link, capture it from
  // the mailer output (DevMailer stderr line or MailChannels/miniflare .eml
  // file), follow it, and store the session cookie into `targetJar`. Returns
  // the captured link (or null). This is the only account-creation path now
  // that email+password sign-up is gone — used for the primary user and for
  // "user B" in the tenancy probe.
  async function signInViaMagicLink(email, targetJar) {
    const marker = devLog.length;
    const linkRes = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, callbackURL: "/dashboard" }),
    });
    if (linkRes.status !== 200) return { status: linkRes.status, magicUrl: null };
    const escEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const devRe = new RegExp(`\\[DevMailer\\] magic link for ${escEmail}: (\\S+)`);
    const magicRe = /\/api\/auth\/magic-link\/verify\?[^\s"'<>)]+/;
    let magicUrl = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !magicUrl) {
      const slice = devLog.slice(marker);
      const dev = slice.match(devRe);
      if (dev) {
        magicUrl = dev[1];
        break;
      }
      // miniflare stubs send_email: the mailer sends a raw-MIME EmailMessage and
      // miniflare logs the block header then the .eml path (full MIME) on a
      // following line. Read every .eml since the marker, match `To:` to this
      // recipient, and pull the verify URL out of the MIME body.
      for (const block of slice.split("send_email binding called")) {
        const fileMatch = block.match(/(\S+\.eml)/);
        if (!fileMatch) continue;
        try {
          const contents = readFileSync(fileMatch[1], "utf8");
          if (!contents.includes(email)) continue;
          const um = contents.match(magicRe);
          if (um) {
            magicUrl = um[0].startsWith("http") ? um[0] : `${BASE}${um[0]}`;
            break;
          }
        } catch {
          /* file not flushed yet */
        }
      }
      if (!magicUrl) await new Promise((r) => setTimeout(r, 100));
    }
    if (!magicUrl) return { status: linkRes.status, magicUrl: null };
    const mu = new URL(magicUrl);
    const verified = await fetch(`${BASE}${mu.pathname}${mu.search}`, {
      method: "GET",
      redirect: "manual",
      headers: { origin: BASE },
    });
    storeCookies(verified, targetJar);
    return { status: linkRes.status, magicUrl };
  }

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
    step(
      "anon /login → 200, passwordless single email form (no password field)",
      login.status === 200 &&
        login.html.includes("Sign in") &&
        login.html.includes('type="email"') &&
        !login.html.includes('type="password"'),
    );

    // 2. passwordless magic-link sign-in → session cookie. In wrangler dev the
    // send_email binding is stubbed by miniflare, so the app uses
    // MailChannelsMailer, which sends a raw-MIME EmailMessage; miniflare writes
    // it to a temp .eml file and logs that path — read the .eml for the verify
    // URL. (If a build ever runs DevMailer instead, its stderr
    // "[DevMailer] …: <url>" line works too.)
    const email = `e2e-ui-${Date.now()}@example.com`;
    const signIn = await signInViaMagicLink(email, jar);
    step("magic-link request returns 200", signIn.status === 200, `status ${signIn.status}`);
    step("captured the sign-in link from the mailer", Boolean(signIn.magicUrl), (signIn.magicUrl ?? "").slice(0, 50));
    step("following the link signs in (session cookie)", jar.size > 0, `${jar.size} cookie(s)`);

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
    step("workspace links to the board", ws.html.includes("/v/ui-vault/board"));

    // 6b. Kanban board SSR (columns + a task card)
    const taskRes = await api("POST", `/api/vaults/${vault.id}/tasks`, {
      body: {
        title: "Ship the board",
        body: "Build the Kanban view.",
        tags: ["high"],
        codeAreas: ["apps/cloud/src/routes/(app)/v/[slug]/board/**"],
      },
    });
    step("create task via REST → 201", taskRes.status === 201, `status ${taskRes.status}`);
    const board = await page("/v/ui-vault/board");
    step("/v/ui-vault/board → 200", board.status === 200, `status ${board.status}`);
    step(
      "board SSR renders the Open · Taken · Done columns",
      board.html.includes(">open<") && board.html.includes(">taken<") && board.html.includes(">done<"),
    );
    step("board SSR renders the task card", board.html.includes("Ship the board"));
    step("board SSR carries the group-by control", board.html.includes("Group by"));

    // A concept-linked task exercises the graph→lane path: the board load pulls
    // the concept graph (source of lane labels / card titles) alongside tasks,
    // and the client then keeps it fresh via a low-cadence graph re-fetch.
    const linkedTask = await api("POST", `/api/vaults/${vault.id}/tasks`, {
      body: {
        title: "Rework auth flow",
        body: "Touches the auth concept.",
        tags: ["medium"],
        domain: "auth-system",
      },
    });
    step("create concept-linked task via REST → 201", linkedTask.status === 201, `status ${linkedTask.status}`);
    const board2 = await page("/v/ui-vault/board");
    step("board SSR renders after loading the concept graph", board2.status === 200, `status ${board2.status}`);
    step("board SSR renders both task cards", board2.html.includes("Ship the board") && board2.html.includes("Rework auth flow"));

    // Dashboard shows the open-task chip now that a task exists.
    const dash2 = await page("/dashboard");
    step("dashboard shows the open-task chip", dash2.html.includes("open task"));

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

    // 9. settings never leaks the plaintext key into SSR (prefix only), and
    // teaches onboarding.
    step(
      "settings SSR never contains the plaintext bz_ key",
      !settings.html.includes(keyRes.json.key),
      `key prefix shown: ${keyRes.json.keyPrefix}`,
    );
    step(
      "settings SSR mentions the onboard tool",
      settings.html.includes("onboard"),
    );

    // 10. anon auth pages: signup SSR. (/claim/[token] — the Wave G claim
    // approval page — is exercised end-to-end in e2e.mjs, where a real
    // emailed token exists.)
    const signupPage = await page("/signup", { cookie: false });
    step(
      "anon /signup → 200 with the signup form",
      signupPage.status === 200 && signupPage.html.includes("Sign up"),
      `status ${signupPage.status}`,
    );

    // 11. UI tenancy: a second user's session gets a 404 for user A's
    // workspace slug — same as a slug that never existed. User B is minted the
    // passwordless way (fresh magic link → own cookie jar); email+password
    // sign-up is gone.
    const jarB = new Map();
    const signInB = await signInViaMagicLink(`e2e-ui-b-${Date.now()}@example.com`, jarB);
    step(
      "second user signs in via magic link → own session cookie",
      Boolean(signInB.magicUrl) && jarB.size > 0,
      `status ${signInB.status}, ${jarB.size} cookie(s)`,
    );
    const cookieB = [...jarB.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const crossWorkspace = await fetch(`${BASE}/v/ui-vault`, { headers: { cookie: cookieB }, redirect: "manual" });
    step("user B's session on A's /v/ui-vault → 404", crossWorkspace.status === 404, `status ${crossWorkspace.status}`);
    const crossSettings = await fetch(`${BASE}/v/ui-vault/settings`, { headers: { cookie: cookieB }, redirect: "manual" });
    step("user B's session on A's settings page → 404", crossSettings.status === 404, `status ${crossSettings.status}`);
    const dashB = await fetch(`${BASE}/dashboard`, { headers: { cookie: cookieB } });
    const dashBHtml = await dashB.text();
    step(
      "user B's dashboard never lists A's vault",
      dashB.status === 200 && !dashBHtml.includes("UI Vault"),
      `status ${dashB.status}`,
    );

    // 12. OAuth consent with more than 5 vaults: search-and-select, "+ New
    // vault" above Allow, and a single submit (SPEC-CLOUD.md "Authorization").
    await consentJourney();
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
