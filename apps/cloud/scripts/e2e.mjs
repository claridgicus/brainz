#!/usr/bin/env node
/**
 * Brainz Cloud E2E journey against `wrangler dev` (the real workerd runtime:
 * SvelteKit worker + D1 + VaultDO, fresh state per run).
 *
 * Flow: passwordless magic-link sign-in (request link → capture from DevMailer
 * → follow it → session cookie) → create vault → upsert concepts (wiki-links,
 * typed relations, code_areas, new ontology types) → search → related →
 * context (budget respected, Code areas line) → graph (pending node) → API key
 * (plaintext once) → MCP over HTTP with the bearer key (initialize,
 * tools/list, get_context, upsert_concept, onboarding nudge,
 * onboard status/start/complete + nudge disappearing) → verify via REST →
 * revoked key gets 401 → Wave G journey over unauthenticated MCP: ANONYMOUS
 * signup (no URL of any kind returned) → key works → `claim` tool → mailer
 * captures the EMAILED approval URL → /claim/<token> page → approve → human
 * session on /dashboard, key still works, token single-use → signup w/ email
 * auto-fires the claim + decline path → per-IP rate limit → invalid bearer
 * still 401 → password sign-in only for the provisioned reviewer → magic-link
 * request rate-limit trips → OAuth 2.1 (discovery, lazy-auth 401, reviewer
 * password login, DCR, consent, PKCE token exchange, MCP over the access
 * token, refresh rotation + reuse revocation) →
 * restart with backdated expiries: unclaimed keys 401 "workspace expired
 * unclaimed", the claimed key keeps working.
 *
 * Email capture: no send_email binding exists in `wrangler dev`, so the app
 * uses DevMailer, which logs `[DevMailer] magic link for <email>: <url>` to
 * stderr. The harness captures that from the wrangler dev output (devLog).
 *
 * Prereqs: repo deps installed and workspace packages built. The script
 * builds the app if needed, applies D1 migrations to a scratch state dir,
 * then boots wrangler dev.
 *
 * Embeddings note: Workers AI needs a Cloudflare login even in local dev —
 * without one the vault degrades to keyword-only search (embeddings:
 * "unavailable"). That path is asserted, not fought.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  apiKeyCreateResponseSchema,
  oauthAuthorizationServerMetadataSchema,
  oauthClientRegistrationResponseSchema,
  oauthProtectedResourceMetadataSchema,
  oauthTokenResponseSchema,
  apiKeyListResponseSchema,
  claimOutputSchema,
  contextResponseSchema,
  getContextOutputSchema,
  getMcpTool,
  graphResponseSchema,
  inviteAcceptResponseSchema,
  inviteCreateResponseSchema,
  inviteListResponseSchema,
  MCP_TOOL_NAMES,
  memberListResponseSchema,
  onboardCompleteOutputSchema,
  onboardStatusOutputSchema,
  publicEnableResponseSchema,
  publicStatusSchema,
  PUBLIC_VAULT_READ_TOOL_NAMES,
  relatedResponseSchema,
  searchResponseSchema,
  signInOutputSchema,
  signupOutputSchema,
  statsResponseSchema,
  syncCompleteOutputSchema,
  syncStatusOutputSchema,
  dreamOutputSchema,
  accountDreamingSchema,
  upsertConceptOutputSchema,
  vaultSchema,
} from "@brainz/contracts";
import { ONBOARDING_NUDGE, ONBOARDING_SUMMARY_ID } from "@brainz/engine";

const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.E2E_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = path.join(appDir, ".wrangler", "e2e-state");
// Directory-reviewer account (Wave OA), provisioned straight into D1 before boot.
const REVIEWER_EMAIL = "reviewer@example.com";
const REVIEWER_PASSWORD = "e2e-reviewer-password-0123456789";

let passed = 0;
let failed = 0;
const notes = [];

function step(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed++;
  else failed++;
  if (!ok) process.exitCode = 1;
}

function assertParse(schema, data, name) {
  const result = schema.safeParse(data);
  step(name, result.success, result.success ? "" : result.error.issues[0]?.message);
  return result.success;
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

function cookieHeader(target = jar) {
  return [...target.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// `jar: <Map>` runs the request as a different browser (tenancy probes).
async function api(method, pathName, { body, cookie = true, bearer, jar: cookieJar = jar } = {}) {
  // Node's fetch (undici) would otherwise send `Origin: null`, which Better
  // Auth rejects; send a real browser-like Origin instead.
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie && cookieJar.size > 0) headers.cookie = cookieHeader(cookieJar);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${BASE}${pathName}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  storeCookies(res, cookieJar);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

// ------------------------------------------------------------------ wrangler

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: appDir, encoding: "utf8", ...opts });
  if (res.status !== 0) {
    console.error(res.stdout, res.stderr);
    throw new Error(`${cmd} ${args.join(" ")} failed (${res.status})`);
  }
  return res;
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
  console.log("== Brainz Cloud E2E ==");

  if (!existsSync(path.join(appDir, ".svelte-kit", "cloudflare", "_worker.js"))) {
    console.log("-- building app (vite build + DO patch)…");
    run("npm", ["run", "build"]);
  }

  rmSync(STATE_DIR, { recursive: true, force: true });
  console.log("-- applying D1 migrations to scratch state…");
  run("npx", ["wrangler", "d1", "migrations", "apply", "brainz", "--local", "--persist-to", STATE_DIR]);
  console.log("-- provisioning the reviewer account…");
  run("node", [
    "scripts/reviewer-account.mjs", "--email", REVIEWER_EMAIL, "--password", REVIEWER_PASSWORD,
    "--local", "--persist-to", STATE_DIR,
  ]);

  console.log(`-- starting wrangler dev on :${PORT}…`);
  // --local: remote bindings (Workers AI) disabled so no Cloudflare login is
  // needed; the vault degrades to keyword-only search, which we assert.
  // BYOK_ENCRYPTION_KEY: the dream-key round trip needs the secret.
  const DEV_ARGS = ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", STATE_DIR, "--show-interactive-dev-session=false", "--var", "BYOK_ENCRYPTION_KEY:e2e-byok-secret"];
  let devLog = "";
  function startDev() {
    // detached → own process group, so stopDev can kill wrangler AND its
    // workerd child (a SIGKILLed wrangler otherwise orphans workerd on the
    // port, and the next instance silently loses the race for it).
    const proc = spawn("npx", DEV_ARGS, { cwd: appDir, stdio: ["ignore", "pipe", "pipe"], detached: true });
    proc.stdout.on("data", (d) => (devLog += d));
    proc.stderr.on("data", (d) => (devLog += d));
    return proc;
  }
  // Stop wrangler dev and WAIT until the port actually closes (graceful
  // SIGTERM first — wrangler tears workerd down itself — then a group
  // SIGKILL as a last resort).
  async function stopDev(proc) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill("SIGTERM");
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${BASE}/`, { redirect: "manual" });
      } catch {
        return; // connection refused — port is free
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  let dev = startDev();

  const MAGIC_RE = /\/api\/auth\/magic-link\/verify\?[^\s"'<>)]+/;

  // Request a magic link for `email`, returning the response + a devLog marker.
  async function requestMagicLink(email, { extraHeaders = {} } = {}) {
    const marker = devLog.length;
    const res = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...extraHeaders },
      body: JSON.stringify({ email, callbackURL: "/dashboard" }),
    });
    return { res, marker };
  }

  // Capture the magic-link URL for `email` from the mailer output after
  // `marker`. Two mailer paths appear in `wrangler dev`:
  //   - DevMailer (no binding): logs "[DevMailer] magic link for <email>: <url>"
  //   - MailChannelsMailer (miniflare stubs the send_email binding): the mailer
  //     now sends a raw-MIME EmailMessage, and miniflare logs
  //         send_email binding called with the following message:
  //           <path>.eml
  //     where <path>.eml is the full raw MIME (multipart/alternative: a
  //     text/plain + text/html part). We read that .eml, match its `To:` header
  //     to THIS recipient, and pull the verify URL out of the MIME body.
  async function captureLink(email, marker) {
    const escEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const devRe = new RegExp(`\\[DevMailer\\] magic link for ${escEmail}: (\\S+)`);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const slice = devLog.slice(marker);
      const dev = slice.match(devRe);
      if (dev) return dev[1];
      // MailChannels/miniflare path: each send logs the block header followed by
      // the .eml path on a subsequent line. Read every .eml since the marker and
      // pick the one addressed to THIS recipient.
      for (const block of slice.split("send_email binding called")) {
        const fileMatch = block.match(/(\S+\.eml)/);
        if (!fileMatch) continue;
        try {
          const contents = readFileSync(fileMatch[1], "utf8");
          // Confirm this .eml is for `email` (To: header, may be "<email>").
          if (!contents.includes(email)) continue;
          const urlMatch = contents.match(MAGIC_RE);
          if (urlMatch) {
            // Absolute URL in the MIME already; make relative ones absolute.
            return urlMatch[0].startsWith("http") ? urlMatch[0] : `${BASE}${urlMatch[0]}`;
          }
        } catch {
          /* file not flushed yet — retry */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  // Capture the EMAILED claim-approval URL for `email` (Wave G). Same two
  // mailer paths as captureLink: DevMailer logs
  //   "[DevMailer] claim approval for <email>: <url>"
  // and the miniflare send_email stub writes the raw MIME to a .eml file, from
  // which we pull the /claim/<64-hex> URL (soft QP line breaks unfolded).
  const CLAIM_RE = /https?:\/\/[^\s"'<>)]*\/claim\/[0-9a-f]{64}|\/claim\/[0-9a-f]{64}/;
  async function captureClaimLink(email, marker) {
    const escEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const devRe = new RegExp(`\\[DevMailer\\] claim approval for ${escEmail}: (\\S+)`);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const slice = devLog.slice(marker);
      const dev = slice.match(devRe);
      if (dev) return dev[1];
      for (const block of slice.split("send_email binding called")) {
        const fileMatch = block.match(/(\S+\.eml)/);
        if (!fileMatch) continue;
        try {
          const contents = readFileSync(fileMatch[1], "utf8").replace(/=\r?\n/g, "");
          if (!contents.includes(email)) continue;
          const urlMatch = contents.match(CLAIM_RE);
          if (urlMatch) {
            return urlMatch[0].startsWith("http") ? urlMatch[0] : `${BASE}${urlMatch[0]}`;
          }
        } catch {
          /* file not flushed yet — retry */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  // Capture the EMAILED vault-invite URL for `email` (Wave M). DevMailer logs
  //   "[DevMailer] invite for <to> to <vaultName> as <role>: <url>"
  // and the miniflare send_email stub writes the raw MIME to a .eml, from which
  // we pull the /invite/<64-hex> URL (soft QP line breaks unfolded).
  const INVITE_RE = /https?:\/\/[^\s"'<>)]*\/invite\/[0-9a-f]{64}|\/invite\/[0-9a-f]{64}/;
  async function captureInviteLink(email, marker) {
    const escEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const devRe = new RegExp(`\\[DevMailer\\] invite for ${escEmail} to .*: (\\S+)`);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const slice = devLog.slice(marker);
      const dev = slice.match(devRe);
      if (dev) return dev[1];
      for (const block of slice.split("send_email binding called")) {
        const fileMatch = block.match(/(\S+\.eml)/);
        if (!fileMatch) continue;
        try {
          const contents = readFileSync(fileMatch[1], "utf8").replace(/=\r?\n/g, "");
          if (!contents.includes(email)) continue;
          const urlMatch = contents.match(INVITE_RE);
          if (urlMatch) {
            return urlMatch[0].startsWith("http") ? urlMatch[0] : `${BASE}${urlMatch[0]}`;
          }
        } catch {
          /* file not flushed yet — retry */
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  // Establish a fresh authenticated session for `email` the passwordless way —
  // request a magic link, capture it from the mailer, follow it — and store the
  // resulting session cookie into `targetJar`. This is the only way to create a
  // second user ("user B") now that email+password sign-up is gone; it reuses
  // the exact request → capture → verify mechanism the primary flow above uses.
  async function signInViaMagicLink(email, targetJar, extraHeaders = {}) {
    const { res, marker } = await requestMagicLink(email, { extraHeaders });
    if (res.status !== 200) return { ok: false, status: res.status, reason: "request" };
    const url = await captureLink(email, marker);
    if (!url) return { ok: false, status: res.status, reason: "capture" };
    const u = new URL(url);
    const verified = await fetch(`${BASE}${u.pathname}${u.search}`, {
      method: "GET",
      redirect: "manual",
      headers: { origin: BASE },
    });
    storeCookies(verified, targetJar);
    return { ok: targetJar.size > 0, status: res.status, reason: "" };
  }

  try {
    await waitForReady(dev);
    console.log("-- wrangler dev ready\n");

    // 1. passwordless magic-link sign-in → session cookie
    const email = `e2e-${Date.now()}@example.com`;
    const linkReq = await requestMagicLink(email);
    step("magic-link request returns 200", linkReq.res.status === 200, `status ${linkReq.res.status}`);
    const capturedUrl = await captureLink(email, linkReq.marker);
    step("mailer produced a verify link (captured)", Boolean(capturedUrl), (capturedUrl ?? "").slice(0, 60));
    step(
      "magic link points at Better Auth's magic-link/verify endpoint",
      /\/api\/auth\/magic-link\/verify\?/.test(capturedUrl ?? ""),
    );
    // Follow it → session (unknown email → user created on verify).
    const verifyUrl = new URL(capturedUrl);
    const verified = await fetch(`${BASE}${verifyUrl.pathname}${verifyUrl.search}`, {
      method: "GET",
      redirect: "manual",
      headers: { origin: BASE },
    });
    storeCookies(verified);
    step("following the magic link sets a session cookie", jar.size > 0, [...jar.keys()].join(", "));

    // verify-email-on-signin: clicking the magic link proves email ownership,
    // so the session-create databaseHook must have flipped emailVerified true
    // (accounts are provisioned emailVerified:false). Read it back from the
    // authenticated session.
    const sess = await fetch(`${BASE}/api/auth/get-session`, {
      method: "GET",
      headers: { origin: BASE, cookie: cookieHeader() },
    });
    const sessJson = await sess.json().catch(() => null);
    step(
      "magic-link sign-in flips emailVerified true (proven-ownership signal)",
      sessJson?.user?.emailVerified === true,
      `emailVerified=${JSON.stringify(sessJson?.user?.emailVerified)}`,
    );

    // Password sign-in exists only for operator-provisioned reviewer accounts
    // (Wave OA): a user's email + any password never signs in, and sign-up is off.
    const pwSignIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: "anything-at-all-123" }),
    });
    step(
      "email+password sign-in never works for a normal (passwordless) user (4xx)",
      pwSignIn.status >= 400 && pwSignIn.status !== 200,
      `status ${pwSignIn.status}`,
    );
    const pwSignUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ name: "X", email: `x-${Date.now()}@example.com`, password: "anything-123" }),
    });
    step(
      "email+password sign-up is disabled (4xx, never 200)",
      pwSignUp.status >= 400 && pwSignUp.status !== 200,
      `status ${pwSignUp.status}`,
    );

    // unauthenticated access is rejected
    const anon = await api("GET", "/api/vaults", { cookie: false });
    step("GET /api/vaults without auth → 401", anon.status === 401, `status ${anon.status}`);

    // 2. create vault
    const vaultRes = await api("POST", "/api/vaults", { body: { name: "E2E Vault" } });
    step("create vault → 201", vaultRes.status === 201, `status ${vaultRes.status}`);
    assertParse(vaultSchema, vaultRes.json, "vault parses with contract vaultSchema");
    const vaultId = vaultRes.json.id;

    // 3. upsert 3 concepts with wiki-links + typed relations
    const concepts = [
      {
        id: "auth-system",
        title: "Auth system",
        type: "feature",
        tags: ["auth"],
        body: "Central authentication: sessions, tokens, and credential storage.",
      },
      {
        id: "user-model",
        title: "User model",
        type: "concept",
        tags: ["auth", "data"],
        body: "The canonical user record. Credentials are managed by [[auth-system]].",
      },
      {
        id: "lead-scoring",
        title: "Lead scoring",
        type: "feature",
        product: "crm",
        tags: ["crm"],
        codeAreas: ["apps/crm/src/scoring/**", "packages/models/src/lead.ts"],
        body: "Scores leads by fit and intent. Reads [[user-model]] data; see also [[missing-concept]].",
        relations: { depends_on: ["auth-system"] },
      },
    ];
    for (const c of concepts) {
      const res = await api("POST", `/api/vaults/${vaultId}/concepts`, { body: c });
      step(`upsert concept ${c.id} → 201`, res.status === 201, `status ${res.status}`);
    }

    // code_areas round-trips through REST
    const leadScoring = await api("GET", `/api/vaults/${vaultId}/concepts/lead-scoring`);
    step(
      "REST GET concept returns codeAreas",
      leadScoring.status === 200 &&
        JSON.stringify(leadScoring.json?.codeAreas) ===
          JSON.stringify(["apps/crm/src/scoring/**", "packages/models/src/lead.ts"]),
      JSON.stringify(leadScoring.json?.codeAreas),
    );
    const domainRes = await api("POST", `/api/vaults/${vaultId}/concepts`, {
      body: { id: "crm-domain", title: "CRM", type: "domain", body: "The CRM product area." },
    });
    step("new ontology type `domain` accepted", domainRes.status === 201, `status ${domainRes.status}`);

    // 4. search (keyword path; embeddings may be unavailable locally)
    const search = await api("GET", `/api/vaults/${vaultId}/search?q=lead%20scoring`);
    step("search → 200", search.status === 200, `status ${search.status}`);
    assertParse(searchResponseSchema, search.json, "search parses with contract schema");
    step(
      "search ranks lead-scoring first",
      search.json?.hits?.[0]?.id === "lead-scoring",
      JSON.stringify(search.json?.hits?.map((h) => h.id)),
    );

    const stats = await api("GET", `/api/vaults/${vaultId}/stats`);
    assertParse(statsResponseSchema, stats.json, "stats parses with contract schema");
    step("stats counts 4 concepts / 4 edges", stats.json?.concepts === 4 && stats.json?.edges === 4,
      `concepts=${stats.json?.concepts} edges=${stats.json?.edges}`);
    step("stats reports onboarded: false pre-onboarding", stats.json?.onboarded === false);
    const keywordIndex = stats.headers.get("x-brainz-keyword-index");
    notes.push(`embeddings: ${stats.json?.embeddings} (Workers AI ${stats.json?.embeddings === "ready" ? "reachable" : "unavailable locally — graceful keyword-only degradation"})`);
    notes.push(`keyword index inside the DO: ${keywordIndex}`);
    step("stats exposes keyword index mode via header", keywordIndex === "fts5" || keywordIndex === "like", String(keywordIndex));

    // 5. related
    const related = await api("GET", `/api/vaults/${vaultId}/related/auth-system?depth=2`);
    step("related → 200", related.status === 200, `status ${related.status}`);
    assertParse(relatedResponseSchema, related.json, "related parses with contract schema");
    const relatedIds = (related.json?.related ?? []).map((r) => r.id).sort();
    step(
      "related(auth-system, depth 2) finds user-model + lead-scoring",
      relatedIds.includes("user-model") && relatedIds.includes("lead-scoring"),
      relatedIds.join(", "),
    );

    // 6. context — full budget, then a tiny budget that must truncate
    const ctx = await api("POST", `/api/vaults/${vaultId}/context`, {
      body: { query: "lead scoring", depth: 1, tokenBudget: 4000 },
    });
    step("context → 200", ctx.status === 200, `status ${ctx.status}`);
    assertParse(contextResponseSchema, ctx.json, "context parses with contract schema");
    step(
      "context bundle contains the lead-scoring section",
      typeof ctx.json?.markdown === "string" && ctx.json.markdown.includes("## Lead scoring (lead-scoring)"),
    );
    step(
      "context section carries the Code areas line",
      ctx.json?.markdown?.includes("Code areas: `apps/crm/src/scoring/**`, `packages/models/src/lead.ts`"),
    );
    const tiny = await api("POST", `/api/vaults/${vaultId}/context`, {
      body: { query: "lead scoring", depth: 1, tokenBudget: 30 },
    });
    step(
      "context respects tokenBudget (approxTokens ≤ 30, truncated)",
      tiny.status === 200 && tiny.json?.truncated === true && tiny.json?.approxTokens <= 30,
      `truncated=${tiny.json?.truncated} approxTokens=${tiny.json?.approxTokens}`,
    );

    // 7. graph — pending node present
    const graph = await api("GET", `/api/vaults/${vaultId}/graph`);
    step("graph → 200", graph.status === 200, `status ${graph.status}`);
    assertParse(graphResponseSchema, graph.json, "graph parses with contract schema");
    const pending = graph.json?.nodes?.find((n) => n.id === "missing-concept");
    step("graph flags missing-concept as pending", pending?.pending === true && pending?.type === "pending");

    // 7b. concept-type registry (Wave TR) — seed, CRUD, unknown-type fallback
    const typesList = await api("GET", `/api/vaults/${vaultId}/types`);
    step("GET /types → 200", typesList.status === 200, `status ${typesList.status}`);
    const seeded = typesList.json?.types ?? [];
    step("fresh vault seeds exactly 11 built-in types", seeded.length === 11, `got ${seeded.length}`);
    const domainType = seeded.find((t) => t.key === "domain");
    const glossaryType = seeded.find((t) => t.key === "glossary");
    step(
      "seed reproduces today's colors + weights (domain #60a5fa/100 > glossary #f472b6/40)",
      domainType?.color === "#60a5fa" &&
        domainType?.weight === 100 &&
        glossaryType?.color === "#f472b6" &&
        glossaryType?.weight === 40 &&
        domainType?.weight > glossaryType?.weight &&
        seeded.every((t) => t.builtin === true),
    );
    // graph payload carries the registry
    step(
      "graph payload carries the 11-type registry",
      Array.isArray(graph.json?.types) && graph.json.types.length === 11,
      `types ${graph.json?.types?.length}`,
    );

    // create a custom type
    const createType = await api("POST", `/api/vaults/${vaultId}/types`, {
      body: { key: "Risk Item!", label: "Risk", color: "#ff0000", weight: 90 },
    });
    step("POST /types custom → 201 (key slugified)", createType.status === 201, `status ${createType.status}`);
    step(
      "custom type key slugified to 'risk-item', not built-in",
      createType.json?.key === "risk-item" && createType.json?.builtin === false,
      createType.json?.key,
    );

    // upsert a concept with the custom type → it survives (registry-valid)
    const customConcept = await api("POST", `/api/vaults/${vaultId}/concepts`, {
      body: { id: "risky-thing", title: "Risky thing", body: "A risk.\n", type: "risk-item" },
    });
    step(
      "concept with custom type keeps type 'risk-item'",
      customConcept.status === 201 && customConcept.json?.type === "risk-item",
      customConcept.json?.type,
    );
    // unknown type → falls back to concept
    const unknownConcept = await api("POST", `/api/vaults/${vaultId}/concepts`, {
      body: { id: "mystery-thing", title: "Mystery", body: "Unknown.\n", type: "totally-made-up" },
    });
    step(
      "unknown type falls back to 'concept'",
      unknownConcept.status === 201 && unknownConcept.json?.type === "concept",
      unknownConcept.json?.type,
    );
    // custom type flows through graph payload → node renders with that type
    const graph2 = await api("GET", `/api/vaults/${vaultId}/graph`);
    const riskyNode = graph2.json?.nodes?.find((n) => n.id === "risky-thing");
    step("custom-typed concept appears in graph with its type", riskyNode?.type === "risk-item");

    // re-weight a built-in via PATCH
    const patchType = await api("PATCH", `/api/vaults/${vaultId}/types/glossary`, {
      body: { weight: 95 },
    });
    step(
      "PATCH built-in weight → 200, re-weighted (still built-in)",
      patchType.status === 200 && patchType.json?.weight === 95 && patchType.json?.builtin === true,
      `status ${patchType.status}`,
    );

    // built-in cannot be hard-deleted
    const delBuiltin = await api("DELETE", `/api/vaults/${vaultId}/types/domain`);
    step("DELETE built-in type → blocked (400)", delBuiltin.status === 400, `status ${delBuiltin.status}`);
    // custom type in use cannot be deleted until reassigned
    const delInUse = await api("DELETE", `/api/vaults/${vaultId}/types/risk-item`);
    step("DELETE custom type in use → blocked (400)", delInUse.status === 400, `status ${delInUse.status}`);
    // remove the concept, then the custom type deletes
    await api("DELETE", `/api/vaults/${vaultId}/concepts/risky-thing`);
    const delFree = await api("DELETE", `/api/vaults/${vaultId}/types/risk-item`);
    step("DELETE unused custom type → 204", delFree.status === 204, `status ${delFree.status}`);

    // 8. API key — plaintext exactly once
    const keyRes = await api("POST", `/api/vaults/${vaultId}/keys`, { body: { name: "e2e-key" } });
    step("create key → 201", keyRes.status === 201, `status ${keyRes.status}`);
    assertParse(apiKeyCreateResponseSchema, keyRes.json, "key create parses with contract schema");
    const bearer = keyRes.json?.key;
    step("plaintext key format bz_<32>", /^bz_[A-Za-z0-9]{32}$/.test(bearer ?? ""), keyRes.json?.keyPrefix);
    const keyList = await api("GET", `/api/vaults/${vaultId}/keys`);
    assertParse(apiKeyListResponseSchema, keyList.json, "key list parses with contract schema");
    step(
      "key list never exposes plaintext",
      keyList.json?.keys?.length === 1 && !("key" in keyList.json.keys[0]),
    );

    // bearer key works on its vault, and ONLY its vault
    const bearerStats = await api("GET", `/api/vaults/${vaultId}/stats`, { cookie: false, bearer });
    step("bearer key reads its vault (stats 200)", bearerStats.status === 200, `status ${bearerStats.status}`);
    const other = await api("POST", "/api/vaults", { body: { name: "Other Vault" } });
    const crossVault = await api("GET", `/api/vaults/${other.json.id}/stats`, { cookie: false, bearer });
    step("bearer key is scoped: other vault → 404", crossVault.status === 404, `status ${crossVault.status}`);
    const keyMint = await api("POST", `/api/vaults/${vaultId}/keys`, {
      cookie: false,
      bearer,
      body: { name: "sneaky" },
    });
    step("keys can't mint keys (bearer → 401)", keyMint.status === 401, `status ${keyMint.status}`);

    // 9. MCP over HTTP with the bearer key
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    });
    const mcp = new Client({ name: "brainz-e2e", version: "0.0.0" });
    await mcp.connect(transport); // initialize handshake
    step("MCP initialize over HTTP succeeds", true);

    const tools = await mcp.listTools();
    const toolNames = tools.tools.map((t) => t.name).sort();
    step(
      "MCP tools/list returns the contract tools + cloud-only claim",
      JSON.stringify(toolNames) === JSON.stringify([...MCP_TOOL_NAMES, "claim"].sort()) &&
        toolNames.includes("onboard") &&
        toolNames.includes("take_task"),
      toolNames.join(", "),
    );

    const ctxTool = await mcp.callTool({ name: "get_context", arguments: { query: "lead scoring" } });
    const blocks = ctxTool.content.filter((c) => c.type === "text").map((c) => c.text);
    step("MCP get_context follows the two-block convention", blocks.length === 2);
    let footerOk = false;
    try {
      footerOk = getContextOutputSchema.safeParse(JSON.parse(blocks[1])).success;
    } catch {
      /* not JSON */
    }
    step("MCP get_context footer parses with contract outputSchema", footerOk, blocks[1]);
    step("MCP get_context markdown includes lead-scoring", blocks[0]?.includes("lead-scoring"));
    step(
      "un-onboarded get_context markdown is prefixed with the onboarding nudge",
      blocks[0]?.startsWith(ONBOARDING_NUDGE),
      blocks[0]?.slice(0, 60),
    );

    const upsert = await mcp.callTool({
      name: "upsert_concept",
      arguments: {
        title: "MCP written note",
        body: "Captured via remote MCP during E2E. Links to [[lead-scoring]].",
        tags: ["e2e"],
        codeAreas: ["scripts/e2e.mjs"],
      },
    });
    const upsertPayload = JSON.parse(upsert.content.find((c) => c.type === "text").text);
    step(
      "MCP upsert_concept output parses with contract outputSchema",
      upsertConceptOutputSchema.strict().safeParse(upsertPayload).success,
      JSON.stringify(upsertPayload),
    );
    step(
      "MCP upsert_concept echoes codeAreas",
      JSON.stringify(upsertPayload?.codeAreas) === JSON.stringify(["scripts/e2e.mjs"]),
    );
    const searchTool = await mcp.callTool({ name: "search_concepts", arguments: { query: "auth" } });
    const searchPayload = JSON.parse(searchTool.content.find((c) => c.type === "text").text);
    step(
      "MCP search_concepts output parses with contract outputSchema",
      getMcpTool("search_concepts").outputSchema.safeParse(searchPayload).success,
    );
    step(
      "un-onboarded search_concepts carries the notice",
      searchPayload?.notice === ONBOARDING_NUDGE,
      String(searchPayload?.notice).slice(0, 60),
    );

    // 9b. onboard flow: status → start (playbook) → complete → nudge gone
    const statusBefore = await mcp.callTool({ name: "onboard", arguments: { action: "status" } });
    const statusBeforePayload = JSON.parse(statusBefore.content.find((c) => c.type === "text").text);
    step(
      "onboard status pre-onboarding parses and reports onboarded: false",
      onboardStatusOutputSchema.safeParse(statusBeforePayload).success &&
        statusBeforePayload.onboarded === false &&
        statusBeforePayload.conceptCount >= 4,
      JSON.stringify(statusBeforePayload),
    );

    const start = await mcp.callTool({
      name: "onboard",
      arguments: { action: "start", productName: "E2E CRM", repoHint: "github.com/e2e/crm" },
    });
    const startBlocks = start.content.filter((c) => c.type === "text").map((c) => c.text);
    step(
      "onboard start returns the playbook as one markdown block",
      start.isError !== true &&
        startBlocks.length === 1 &&
        startBlocks[0].includes("Onboarding playbook — E2E CRM") &&
        startBlocks[0].includes("github.com/e2e/crm") &&
        !startBlocks[0].includes("20–60 concepts") &&
        startBlocks[0].includes("200–800+ concepts") &&
        startBlocks[0].includes("realized_by") &&
        startBlocks[0].includes("governs"),
    );

    // 9b-i. status WITH an areaList returns a coverage report. Only lead-scoring
    // carries codeAreas (apps/crm/**, packages/models/**), so apps/crm is
    // covered and the un-anchored areas are uncovered.
    const statusCoverage = await mcp.callTool({
      name: "onboard",
      arguments: {
        action: "status",
        areaList: ["apps/crm/src", "packages/models", "packages/engine", "apps/api", "packages/ui"],
      },
    });
    const statusCoveragePayload = JSON.parse(statusCoverage.content.find((c) => c.type === "text").text);
    step(
      "onboard status with areaList returns a coverage report (covered vs uncovered)",
      onboardStatusOutputSchema.safeParse(statusCoveragePayload).success &&
        statusCoveragePayload.coverage?.covered.includes("apps/crm/src") &&
        statusCoveragePayload.coverage?.covered.includes("packages/models") &&
        statusCoveragePayload.coverage?.uncovered.includes("packages/engine") &&
        typeof statusCoveragePayload.coverage?.coveragePct === "number",
      JSON.stringify(statusCoveragePayload),
    );

    // 9b-ii. complete with THIN coverage is rejected, listing uncovered areas.
    const thinComplete = await mcp.callTool({
      name: "onboard",
      arguments: {
        action: "complete",
        summary: "Barely indexed.",
        areaList: ["apps/crm/src", "packages/engine", "apps/api", "packages/ui", "packages/core"],
      },
    });
    const thinText = thinComplete.content.filter((c) => c.type === "text").map((c) => c.text)[0] ?? "";
    step(
      "onboard complete with thin coverage is rejected, listing uncovered areas",
      thinComplete.isError === true &&
        thinText.includes("onboarding looks incomplete") &&
        thinText.includes("packages/engine"),
      thinText,
    );

    const incomplete = await mcp.callTool({ name: "onboard", arguments: { action: "complete" } });
    step("onboard complete without a summary is an isError", incomplete.isError === true);

    const complete = await mcp.callTool({
      name: "onboard",
      arguments: { action: "complete", summary: "Indexed the E2E CRM: 1 domain, 2 features." },
    });
    const completePayload = JSON.parse(complete.content.find((c) => c.type === "text").text);
    step(
      "onboard complete parses and names the summary concept",
      onboardCompleteOutputSchema.safeParse(completePayload).success &&
        completePayload.summaryConceptId === ONBOARDING_SUMMARY_ID,
      JSON.stringify(completePayload),
    );
    step(
      "onboard complete surfaces quality signals on the sealed graph",
      completePayload.conceptCount >= 1 &&
        typeof completePayload.conceptsLackingCodeAreas === "number" &&
        typeof completePayload.hasDomainConcepts === "boolean" &&
        completePayload.byType !== null &&
        typeof completePayload.byType === "object",
      JSON.stringify(completePayload),
    );

    const statusAfter = await mcp.callTool({ name: "onboard", arguments: { action: "status" } });
    const statusAfterPayload = JSON.parse(statusAfter.content.find((c) => c.type === "text").text);
    step("onboard status flips to onboarded: true", statusAfterPayload.onboarded === true);

    const startAgain = await mcp.callTool({
      name: "onboard",
      arguments: { action: "start", productName: "E2E CRM" },
    });
    const startAgainText = startAgain.content.filter((c) => c.type === "text").map((c) => c.text)[0] ?? "";
    step(
      "onboard start on an already-onboarded vault returns the idempotency guard, not the playbook",
      startAgain.isError === true &&
        startAgainText.includes("already onboarded on") &&
        !startAgainText.includes("Onboarding playbook"),
      startAgainText,
    );

    const statsTool = await mcp.callTool({ name: "vault_stats", arguments: {} });
    const statsToolPayload = JSON.parse(statsTool.content.find((c) => c.type === "text").text);
    step(
      "vault_stats reports onboarded: true and parses strictly",
      statsToolPayload.onboarded === true &&
        getMcpTool("vault_stats").outputSchema.safeParse(statsToolPayload).success,
    );

    const searchAfter = await mcp.callTool({ name: "search_concepts", arguments: { query: "auth" } });
    const searchAfterPayload = JSON.parse(searchAfter.content.find((c) => c.type === "text").text);
    step("nudge disappears from search_concepts after complete", searchAfterPayload.notice === undefined);
    const ctxAfter = await mcp.callTool({ name: "get_context", arguments: { query: "lead scoring" } });
    const ctxAfterMarkdown = ctxAfter.content.filter((c) => c.type === "text")[0]?.text ?? "";
    step(
      "nudge disappears from get_context after complete",
      !ctxAfterMarkdown.startsWith(ONBOARDING_NUDGE),
    );

    // 9b-sync. sync flow: start (drift playbook) → status → complete (appends log + last_synced_at)
    const syncStart = await mcp.callTool({
      name: "sync",
      arguments: { action: "start", productName: "E2E CRM", areaList: ["apps/crm/src"] },
    });
    const syncStartText = syncStart.content.filter((c) => c.type === "text").map((c) => c.text)[0] ?? "";
    step(
      "sync start returns the DRIFT playbook (not the onboarding playbook)",
      syncStart.isError !== true &&
        syncStartText.includes("Sync playbook — E2E CRM") &&
        !syncStartText.includes("Onboarding playbook") &&
        syncStartText.includes("Diff the codebase since the last sync") &&
        syncStartText.includes("Update stale concepts whose code_areas changed") &&
        syncStartText.includes("Index new / un-mapped work"),
      syncStartText.slice(0, 200),
    );

    const syncStatus = await mcp.callTool({ name: "sync", arguments: { action: "status" } });
    const syncStatusPayload = JSON.parse(syncStatus.content.find((c) => c.type === "text").text);
    step(
      "sync status reports onboarded + lastSyncedAt + stale=false (freshly onboarded)",
      syncStatusOutputSchema.safeParse(syncStatusPayload).success &&
        syncStatusPayload.onboarded === true &&
        typeof syncStatusPayload.lastSyncedAt === "string" &&
        syncStatusPayload.stale === false,
      JSON.stringify(syncStatusPayload),
    );

    const syncComplete = await mcp.callTool({
      name: "sync",
      arguments: { action: "complete", summary: "Re-synced CRM after the scoring change." },
    });
    const syncCompletePayload = JSON.parse(syncComplete.content.find((c) => c.type === "text").text);
    step(
      "sync complete records last_synced_at and names the summary concept",
      syncCompleteOutputSchema.safeParse(syncCompletePayload).success &&
        typeof syncCompletePayload.lastSyncedAt === "string" &&
        syncCompletePayload.summaryConceptId === ONBOARDING_SUMMARY_ID,
      JSON.stringify(syncCompletePayload),
    );

    const summaryAfterSync = await mcp.callTool({
      name: "get_concept",
      arguments: { id: ONBOARDING_SUMMARY_ID },
    });
    const summaryAfterSyncPayload = JSON.parse(
      summaryAfterSync.content.find((c) => c.type === "text").text,
    );
    step(
      "sync complete APPENDS to the summary concept (running log): onboarding note + sync note both survive",
      summaryAfterSyncPayload.body.includes("Indexed the E2E CRM") &&
        summaryAfterSyncPayload.body.includes("Re-synced CRM after the scoring change.") &&
        summaryAfterSyncPayload.body.includes("## Sync "),
      summaryAfterSyncPayload.body,
    );

    // 9b-dream. dreaming: the DO armed its alarm; a manual run sweeps the vault.
    // `wrangler dev --local` has no usable Workers AI, so REM is skipped
    // (absent binding or llm-error) and the run is light-only — nothing written.
    const dreamStatus = await mcp.callTool({ name: "dream", arguments: { action: "status" } });
    const dreamStatusPayload = JSON.parse(dreamStatus.content.find((c) => c.type === "text").text);
    step(
      "dream status: enabled with a scheduled nightly alarm",
      dreamOutputSchema.safeParse(dreamStatusPayload).success &&
        dreamStatusPayload.enabled === true &&
        typeof dreamStatusPayload.nextDreamAt === "string",
      JSON.stringify(dreamStatusPayload),
    );
    step(
      "dream status reports spend controls: provider, kill switch off, $1/day cap billed to the owner",
      dreamStatusPayload.killSwitch === "off" &&
        (dreamStatusPayload.provider === "workers-ai" || dreamStatusPayload.provider === null) &&
        dreamStatusPayload.spend?.capUsd === 1 &&
        dreamStatusPayload.spend?.remainingUsd <= 1 &&
        /^\d{4}-\d{2}-\d{2}$/.test(dreamStatusPayload.spend?.day ?? ""),
      JSON.stringify(dreamStatusPayload),
    );
    const dreamRun = await mcp.callTool({ name: "dream", arguments: { action: "run" } });
    const dreamRunPayload = JSON.parse(dreamRun.content.find((c) => c.type === "text").text);
    step(
      "dream run sweeps the vault and writes a diary entry (REM skipped without AI)",
      dreamOutputSchema.safeParse(dreamRunPayload).success &&
        dreamRunPayload.status === "done" &&
        dreamRunPayload.entry?.status === "light-only",
      JSON.stringify(dreamRunPayload).slice(0, 400),
    );
    const dreamDiary = await mcp.callTool({ name: "dream", arguments: { action: "diary" } });
    const dreamDiaryPayload = JSON.parse(dreamDiary.content.find((c) => c.type === "text").text);
    step(
      "dream diary lists the run",
      dreamOutputSchema.safeParse(dreamDiaryPayload).success &&
        dreamDiaryPayload.entries[0]?.id === dreamRunPayload.id,
      JSON.stringify(dreamDiaryPayload).slice(0, 300),
    );

    // 9b-dream-byok. account dreaming: spend view, set a key (only a hint comes
    // back), the vault's dreams switch to it, remove it again.
    const dreamingView = await api("GET", "/api/account/dreaming");
    step(
      "GET /api/account/dreaming → spend vs cap, no key, kill switch off",
      dreamingView.status === 200 &&
        accountDreamingSchema.safeParse(dreamingView.json).success &&
        dreamingView.json.key === null &&
        dreamingView.json.spend.capUsd === 1 &&
        dreamingView.json.killSwitch === "off",
      dreamingView.text.slice(0, 300),
    );
    const byokPlain = "sk-ant-api03-e2e-not-a-real-key-WXYZ";
    const setKey = await api("PUT", "/api/account/llm-key", {
      body: { provider: "anthropic", apiKey: byokPlain },
    });
    step(
      "PUT /api/account/llm-key stores the key and returns only its hint",
      setKey.status === 200 &&
        accountDreamingSchema.safeParse(setKey.json).success &&
        setKey.json.provider === "byok:anthropic" &&
        setKey.json.key?.hint === "sk-ant-…WXYZ" &&
        !setKey.text.includes("e2e-not-a-real-key"),
      setKey.text.slice(0, 300),
    );
    const byokStatus = JSON.parse(
      (await mcp.callTool({ name: "dream", arguments: { action: "status" } })).content.find((c) => c.type === "text")
        .text,
    );
    step(
      "dream status now reports the owner's own key as the provider",
      dreamOutputSchema.safeParse(byokStatus).success && byokStatus.provider === "byok:anthropic",
      JSON.stringify(byokStatus).slice(0, 300),
    );
    const badOpenAi = await api("PUT", "/api/account/llm-key", {
      body: { provider: "openai", apiKey: "sk-abcdefghijkl", baseUrl: "http://insecure.example.com" },
    });
    step("an OpenAI-compatible key without https base URL + model is rejected (400)", badOpenAi.status === 400, badOpenAi.text);
    const delKey = await api("DELETE", "/api/account/llm-key");
    step(
      "DELETE /api/account/llm-key removes it (back on the capped default)",
      delKey.status === 200 && delKey.json?.key === null && delKey.json?.provider !== "byok:anthropic",
      delKey.text.slice(0, 300),
    );
    const anonDreaming = await api("GET", "/api/account/dreaming", { cookie: false });
    step("account dreaming requires a session (401)", anonDreaming.status === 401, anonDreaming.text);

    // 9c. task tools: create → list → take (+ context bundle) → reject → complete
    const createdTask = await mcp.callTool({
      name: "create_task",
      arguments: {
        title: "E2E task: wire billing",
        body: "Handle Stripe events. Relates to [[lead-scoring]].",
        tags: ["high"],
        codeAreas: ["apps/billing/src/**"],
      },
    });
    const createdTaskPayload = JSON.parse(createdTask.content.find((c) => c.type === "text").text);
    step(
      "MCP create_task creates an open task-type concept (parses w/ contract schema)",
      getMcpTool("create_task").outputSchema.safeParse(createdTaskPayload).success &&
        createdTaskPayload.type === "task" &&
        createdTaskPayload.taskStatus === "open",
      JSON.stringify(createdTaskPayload),
    );
    const taskId = createdTaskPayload.id;

    const listTasks = await mcp.callTool({ name: "list_tasks", arguments: { taskStatus: "open" } });
    const listTasksPayload = JSON.parse(listTasks.content.find((c) => c.type === "text").text);
    step(
      "MCP list_tasks returns the new open task (parses w/ contract schema)",
      getMcpTool("list_tasks").outputSchema.safeParse(listTasksPayload).success &&
        listTasksPayload.tasks.some((t) => t.id === taskId),
      JSON.stringify(listTasksPayload.tasks.map((t) => t.id)),
    );

    const takeTask = await mcp.callTool({
      name: "take_task",
      arguments: { id: taskId, takenBy: "e2e-fleet" },
    });
    const takePayload = JSON.parse(takeTask.content.find((c) => c.type === "text").text);
    step(
      "MCP take_task claims the task, records takenBy, and returns a context bundle",
      getMcpTool("take_task").outputSchema.safeParse(takePayload).success &&
        takePayload.task.taskStatus === "taken" &&
        takePayload.task.takenBy === "e2e-fleet" &&
        typeof takePayload.context.markdown === "string",
      JSON.stringify(takePayload.task),
    );

    const takeAgain = await mcp.callTool({ name: "take_task", arguments: { id: taskId } });
    step("MCP take_task on an already-taken task is an isError", takeAgain.isError === true);

    const completeTask = await mcp.callTool({
      name: "complete_task",
      arguments: { id: taskId, outcome: "Billing webhooks wired and tested." },
    });
    const completeTaskPayload = JSON.parse(completeTask.content.find((c) => c.type === "text").text);
    step(
      "MCP complete_task marks done and reminds to index changes",
      getMcpTool("complete_task").outputSchema.safeParse(completeTaskPayload).success &&
        completeTaskPayload.task.taskStatus === "done" &&
        completeTaskPayload.reminder.includes("upsert_concept"),
      JSON.stringify(completeTaskPayload.task),
    );
    await mcp.close();

    // task REST surface: GET /tasks lists task metas (session cookie)
    const tasksRest = await api("GET", `/api/vaults/${vaultId}/tasks`);
    step(
      "REST GET /tasks lists the task (now done) with its task fields",
      tasksRest.status === 200 &&
        Array.isArray(tasksRest.json?.tasks) &&
        tasksRest.json.tasks.some((t) => t.id === taskId && t.taskStatus === "done"),
      `status ${tasksRest.status}`,
    );
    const openTasksRest = await api("GET", `/api/vaults/${vaultId}/tasks?taskStatus=open`);
    step(
      "REST GET /tasks?taskStatus=open filters to open tasks only",
      openTasksRest.status === 200 &&
        openTasksRest.json.tasks.every((t) => (t.taskStatus ?? "open") === "open"),
      `status ${openTasksRest.status}`,
    );

    // the onboarding summary is a spec concept readable via REST; D1 mirror feeds stats
    const summaryRest = await api("GET", `/api/vaults/${vaultId}/concepts/${ONBOARDING_SUMMARY_ID}`);
    step(
      "onboarding summary readable via REST as a spec concept",
      summaryRest.status === 200 &&
        summaryRest.json?.type === "spec" &&
        summaryRest.json?.body?.includes("Indexed the E2E CRM"),
      `status ${summaryRest.status} type=${summaryRest.json?.type}`,
    );
    const statsAfterRest = await api("GET", `/api/vaults/${vaultId}/stats`);
    step("REST stats reports onboarded: true post-onboarding", statsAfterRest.json?.onboarded === true);

    // 10. the MCP write is visible via REST
    const written = await api("GET", `/api/vaults/${vaultId}/concepts/mcp-written-note`);
    step("MCP-written concept readable via REST", written.status === 200 && written.json?.title === "MCP written note");

    // 11. revoke the key → 401
    const revoke = await api("DELETE", `/api/keys/${keyRes.json.id}`);
    step("revoke key → 204", revoke.status === 204, `status ${revoke.status}`);
    const afterRevoke = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    step("revoked bearer on /mcp → 401", afterRevoke.status === 401, `status ${afterRevoke.status}`);

    // 12. PUBLIC signup: absent auth serves a public MCP server (signup only)
    const pubTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
    const pub = new Client({ name: "brainz-e2e-public", version: "0.0.0" });
    await pub.connect(pubTransport);
    step("MCP initialize WITHOUT auth succeeds (public server)", true);

    const pubTools = await pub.listTools();
    const pubNames = pubTools.tools.map((t) => t.name);
    step(
      "unauthenticated tools/list is [signup, sign_in, ...vault tools] (lazy auth) — never claim",
      JSON.stringify(pubNames) === JSON.stringify(["signup", "sign_in", ...MCP_TOOL_NAMES]) &&
        !pubNames.includes("claim"),
      pubNames.join(", "),
    );

    // Signup v2 (Wave G) is ANONYMOUS: no email required, provisional 7-day
    // workspace, and NEVER a URL of any kind in the result.
    const signupRes = await pub.callTool({
      name: "signup",
      arguments: { vaultName: "Agent Vault" },
    });
    step(
      "public anonymous signup (no email) succeeds",
      signupRes.isError !== true,
      signupRes.isError ? (signupRes.content.find((c) => c.type === "text")?.text ?? "").slice(0, 160) : "",
    );
    const signupBlocks = signupRes.content.filter((c) => c.type === "text").map((c) => c.text);
    const signupPayload = JSON.parse(signupBlocks[0]);
    assertParse(signupOutputSchema, signupPayload, "signup output parses with contract schema");
    step(
      "signup output: slug from vaultName, claimEmailSent false, ~7-day expiresAt",
      signupPayload.vaultSlug === "agent-vault" &&
        signupPayload.claimEmailSent === false &&
        new Date(signupPayload.expiresAt).getTime() > Date.now() + 6 * 24 * 3600 * 1000,
      `${signupPayload.vaultSlug} expires ${signupPayload.expiresAt}`,
    );
    step(
      "signup result carries NO URL of any kind (no loginUrl/claimUrl, nothing http)",
      !("loginUrl" in signupPayload) &&
        !("claimUrl" in signupPayload) &&
        !signupBlocks.some((t) => /https?:\/\//.test(t)),
    );
    step(
      "signup appends the guardrail guidance block (secret key, expiry, claim)",
      signupBlocks.length === 2 && /SECRET/i.test(signupBlocks[1]) && /`claim`/.test(signupBlocks[1]),
      (signupBlocks[1] ?? "").slice(0, 70),
    );

    // 12b. PUBLIC sign_in: emails a magic sign-in link for a returning human.
    // CRITICAL: the tool result carries NO login URL — the human must action
    // the emailed link. We prove the mailer/send path fired by capturing the
    // emailed magic link from the DevMailer output, and that the result leaks
    // nothing about account existence.
    const signInEmail = `signin-${Date.now()}@example.com`;
    const signInMarker = devLog.length;
    const signInRes = await pub.callTool({ name: "sign_in", arguments: { email: signInEmail } });
    const signInBlocks = signInRes.content.filter((c) => c.type === "text").map((c) => c.text);
    step(
      "public sign_in call succeeds",
      signInRes.isError !== true,
      signInRes.isError ? (signInBlocks[0] ?? "").slice(0, 160) : "",
    );
    const signInPayload = JSON.parse(signInBlocks[0]);
    assertParse(signInOutputSchema, signInPayload, "sign_in output parses with contract schema");
    step(
      "sign_in result is the generic {status:'sent'} and carries NO login URL of any kind",
      signInPayload.status === "sent" &&
        !("loginUrl" in signInPayload) &&
        !("url" in signInPayload) &&
        !signInBlocks.some((t) => /https?:\/\//.test(t)),
      signInBlocks.join(" | ").slice(0, 80),
    );
    step(
      "sign_in confirmation tells the human to action the link from their inbox",
      signInBlocks.some((t) => /inbox/i.test(t)),
    );
    // The magic link itself is EMAILED — captured from the mailer, never returned.
    const signInUrl = await captureLink(signInEmail, signInMarker);
    step(
      "sign_in EMAILED a magic-link (mailer/send path invoked) — link only in the email",
      Boolean(signInUrl) && /magic-link\/verify/.test(signInUrl ?? ""),
      (signInUrl ?? "").slice(0, 70),
    );

    // Rate limit: 5 sign-in emails/hour/email. The 6th for the SAME address in
    // the window trips a friendly isError with no existence leak.
    let signInThrottled = false;
    for (let i = 0; i < 6; i++) {
      const r = await pub.callTool({ name: "sign_in", arguments: { email: signInEmail } });
      if (r.isError === true) {
        signInThrottled = true;
        const t = r.content.find((c) => c.type === "text")?.text ?? "";
        step(
          "sign_in rate-limit trips with a friendly message (no existence leak)",
          /rate limit/i.test(t) && !/account (exists|not found)/i.test(t),
          t.slice(0, 80),
        );
        break;
      }
    }
    step("sign_in rate limit is enforced within the window", signInThrottled);

    const claimedKey = signupPayload.apiKey;

    // the returned apiKey works immediately on the authenticated MCP surface
    const agentTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${signupPayload.apiKey}` } },
    });
    const agentMcp = new Client({ name: "brainz-e2e-agent", version: "0.0.0" });
    await agentMcp.connect(agentTransport);
    const agentStats = await agentMcp.callTool({ name: "vault_stats", arguments: {} });
    const agentStatsPayload = JSON.parse(agentStats.content.find((c) => c.type === "text").text);
    step(
      "signup apiKey unlocks vault_stats over /mcp with bearer",
      agentStats.isError !== true &&
        getMcpTool("vault_stats").outputSchema.safeParse(agentStatsPayload).success,
      `concepts=${agentStatsPayload?.concepts}`,
    );

    // 13. CLAIM-TO-PERSIST: the authenticated surface carries the cloud-only
    // `claim` tool; the approval link travels by EMAIL only (mailer capture).
    const agentTools = await agentMcp.listTools();
    const agentToolNames = agentTools.tools.map((t) => t.name).sort();
    step(
      "authenticated tools/list = MCP_TOOLS + claim (cloud-only)",
      JSON.stringify(agentToolNames) === JSON.stringify([...MCP_TOOL_NAMES, "claim"].sort()),
      agentToolNames.join(", "),
    );

    const claimEmail = `claimer-${Date.now()}@example.com`;
    const claimMarker = devLog.length;
    const claimRes = await agentMcp.callTool({ name: "claim", arguments: { email: claimEmail } });
    const claimBlocks = claimRes.content.filter((c) => c.type === "text").map((c) => c.text);
    step(
      "claim tool call succeeds",
      claimRes.isError !== true,
      claimRes.isError ? (claimBlocks[0] ?? "").slice(0, 160) : "",
    );
    const claimPayload = JSON.parse(claimBlocks[0]);
    assertParse(claimOutputSchema, claimPayload, "claim output parses with contract schema");
    step(
      "claim result is {status: sent} with a future expiry and NO URL/token",
      claimPayload.status === "sent" &&
        new Date(claimPayload.expiresAt).getTime() > Date.now() &&
        !claimBlocks.some((t) => /https?:\/\/|\/claim\//.test(t)),
    );

    const claimUrl = await captureClaimLink(claimEmail, claimMarker);
    step("mailer captured the EMAILED approval URL", Boolean(claimUrl), (claimUrl ?? "").slice(0, 70));
    const claimPath = new URL(claimUrl).pathname;
    step("approval URL is /claim/<64-hex-token>", /^\/claim\/[0-9a-f]{64}$/.test(claimPath), claimPath);

    // The approval page shows what's being approved (load contract).
    const claimPage = await fetch(`${BASE}${claimPath}`, { headers: { origin: BASE } });
    const claimPageHtml = await claimPage.text();
    step(
      "claim page renders the email + vault being attached",
      claimPage.status === 200 &&
        claimPageHtml.includes(claimEmail) &&
        claimPageHtml.includes("Agent Vault"),
      `status ${claimPage.status}`,
    );

    // Approve (plain form POST): atomic bind, then a 303 to a short-lived
    // magic-link verify URL that signs THIS browser in, landing on /dashboard.
    // `accept: text/html` = the plain-browser form flow (redirects are real
    // 303s, failures real 400s); without it SvelteKit answers with the JSON
    // ActionResult envelope instead.
    const approveRes = await fetch(`${BASE}${claimPath}?/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: BASE, accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const verifyLocation = approveRes.headers.get("location") ?? "";
    step(
      "approve action 303-redirects to the magic-link verify URL",
      approveRes.status === 303 && /\/api\/auth\/magic-link\/verify\?/.test(verifyLocation),
      `status ${approveRes.status} → ${verifyLocation.slice(0, 70)}`,
    );

    const humanJar = new Map();
    const approveVerifyUrl = new URL(verifyLocation, BASE);
    const approveVerified = await fetch(`${BASE}${approveVerifyUrl.pathname}${approveVerifyUrl.search}`, {
      method: "GET",
      redirect: "manual",
      headers: { origin: BASE },
    });
    storeCookies(approveVerified, humanJar);
    step(
      "following the approve redirect signs the human in (session cookie)",
      (approveVerified.status === 302 || approveVerified.status === 303) && humanJar.size > 0,
      `status ${approveVerified.status} → ${approveVerified.headers.get("location")}`,
    );

    const humanCookie = cookieHeader(humanJar);
    const humanSession = await fetch(`${BASE}/api/auth/get-session`, {
      headers: { origin: BASE, cookie: humanCookie },
    });
    const humanSessionJson = await humanSession.json().catch(() => null);
    step(
      "claim bound the email and verified it (account permanent)",
      humanSessionJson?.user?.email === claimEmail &&
        humanSessionJson?.user?.emailVerified === true,
      `email=${humanSessionJson?.user?.email} verified=${humanSessionJson?.user?.emailVerified}`,
    );

    const humanVaults = await fetch(`${BASE}/api/vaults`, { headers: { cookie: humanCookie } });
    const humanVaultsJson = await humanVaults.json().catch(() => null);
    step(
      "claimed session sees the agent-created vault via GET /api/vaults",
      humanVaults.status === 200 &&
        humanVaultsJson?.vaults?.some((v) => v.slug === signupPayload.vaultSlug),
      JSON.stringify(humanVaultsJson?.vaults?.map((v) => v.slug)),
    );

    const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: humanCookie } });
    const dashHtml = await dash.text();
    step(
      "dashboard loads for the claimed session and lists the vault",
      dash.status === 200 && dashHtml.includes("Agent Vault"),
      `status ${dash.status}`,
    );

    // The agent's key KEEPS working after the claim.
    const statsAfterClaim = await agentMcp.callTool({ name: "vault_stats", arguments: {} });
    step("agent apiKey still works after the claim is approved", statsAfterClaim.isError !== true);

    // Single-use: a consumed token never approves twice.
    const approveAgain = await fetch(`${BASE}${claimPath}?/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: BASE, accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    step("re-approving a consumed claim token → 400", approveAgain.status === 400, `status ${approveAgain.status}`);

    // …and claiming an already-claimed workspace is an isError.
    const reclaim = await agentMcp.callTool({
      name: "claim",
      arguments: { email: `again-${Date.now()}@example.com` },
    });
    const reclaimText = reclaim.content.find((c) => c.type === "text")?.text ?? "";
    step(
      "claim on an already-claimed workspace → isError with settings guidance",
      reclaim.isError === true && /already claimed/.test(reclaimText),
      reclaimText.slice(0, 80),
    );
    await agentMcp.close();

    // 13b. signup WITH email auto-fires the same claim request; decline path.
    const declineEmail = `decliner-${Date.now()}@example.com`;
    const declineMarker = devLog.length;
    const signup2 = await pub.callTool({
      name: "signup",
      arguments: { vaultName: "Second Vault", email: declineEmail },
    });
    const signup2Payload = JSON.parse(signup2.content.find((c) => c.type === "text").text);
    step(
      "signup with email reports claimEmailSent true (still no URL, no dup-email error)",
      signup2.isError !== true &&
        signup2Payload.claimEmailSent === true &&
        !("loginUrl" in signup2Payload),
      JSON.stringify(signup2Payload).slice(0, 100),
    );
    const declineUrl = await captureClaimLink(declineEmail, declineMarker);
    step("signup-supplied email got the approval email (mailer capture)", Boolean(declineUrl));
    const declinePath = new URL(declineUrl).pathname;
    const declineRes = await fetch(`${BASE}${declinePath}?/decline`, {
      method: "POST",
      headers: { origin: BASE, accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const declineHtml = await declineRes.text();
    step(
      "decline action confirms nothing was attached",
      declineRes.status === 200 && /Claim declined/i.test(declineHtml),
      `status ${declineRes.status}`,
    );
    const declinedApprove = await fetch(`${BASE}${declinePath}?/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: BASE, accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    step("approving a declined claim → 400", declinedApprove.status === 400, `status ${declinedApprove.status}`);

    // 13d. RECONCILE-TO-EXISTING (identity-fork fix): when the approved email
    // ALREADY has a real account, approval must MOVE the provisioned vault to
    // that account and DELETE the provisional user — not fork a second identity
    // or orphan the vault. This is the exact production incident.
    const reconcileEmail = `existing-${Date.now()}@example.com`;
    // (a) the human already has a real, verified account (magic-link sign-in).
    const existingJar = new Map();
    const existingSignIn = await signInViaMagicLink(reconcileEmail, existingJar);
    step(
      "reconcile: existing human account established via magic-link",
      existingSignIn.ok === true && existingJar.size > 0,
      JSON.stringify(existingSignIn).slice(0, 80),
    );
    const existingCookie = cookieHeader(existingJar);
    const existingVaultsBefore = await fetch(`${BASE}/api/vaults`, {
      headers: { cookie: existingCookie },
    });
    const existingVaultsBeforeJson = await existingVaultsBefore.json().catch(() => null);
    const slugsBefore = (existingVaultsBeforeJson?.vaults ?? []).map((v) => v.slug);

    // (b) an agent provisions a FRESH provisional workspace (no email).
    const reconcileSignup = await pub.callTool({
      name: "signup",
      arguments: { vaultName: "Reconcile Vault" },
    });
    const reconcileSignupPayload = JSON.parse(
      reconcileSignup.content.find((c) => c.type === "text").text,
    );
    const reconcileVaultSlug = reconcileSignupPayload.vaultSlug;
    step(
      "reconcile: fresh provisional signup succeeds",
      reconcileSignup.isError !== true && /^bz_/.test(reconcileSignupPayload.apiKey ?? ""),
    );

    // (c) the agent claims to the EXISTING human's email.
    const reconcileTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${reconcileSignupPayload.apiKey}` } },
    });
    const reconcileMcp = new Client({ name: "brainz-e2e-reconcile", version: "0.0.0" });
    await reconcileMcp.connect(reconcileTransport);
    const reconcileMarker = devLog.length;
    const reconcileClaim = await reconcileMcp.callTool({
      name: "claim",
      arguments: { email: reconcileEmail },
    });
    step(
      "reconcile: claim to an already-registered email still returns {status: sent} (no oracle)",
      reconcileClaim.isError !== true &&
        JSON.parse(reconcileClaim.content.find((c) => c.type === "text").text).status === "sent",
    );

    // (d) the human approves the EMAILED link — this reconciles.
    const reconcileUrl = await captureClaimLink(reconcileEmail, reconcileMarker);
    step(
      "reconcile: an approval link WAS emailed to the existing address",
      Boolean(reconcileUrl),
      (reconcileUrl ?? "").slice(0, 70),
    );
    const reconcilePath = new URL(reconcileUrl).pathname;
    const reconcileApprove = await fetch(`${BASE}${reconcilePath}?/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: BASE, accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    step(
      "reconcile: approve 303-redirects (signs the EXISTING human in)",
      reconcileApprove.status === 303,
      `status ${reconcileApprove.status}`,
    );

    // (e) the provisioned vault now appears in the EXISTING account's list.
    const existingVaultsAfter = await fetch(`${BASE}/api/vaults`, {
      headers: { cookie: existingCookie },
    });
    const existingVaultsAfterJson = await existingVaultsAfter.json().catch(() => null);
    const slugsAfter = (existingVaultsAfterJson?.vaults ?? []).map((v) => v.slug);
    step(
      "reconcile: the provisioned vault is now owned by the EXISTING account",
      existingVaultsAfter.status === 200 &&
        slugsAfter.length === slugsBefore.length + 1 &&
        slugsAfter.includes(reconcileVaultSlug),
      `before=${JSON.stringify(slugsBefore)} after=${JSON.stringify(slugsAfter)}`,
    );
    // The agent key still works — it's vault-scoped and followed the vault.
    const reconcileStatsAfter = await reconcileMcp.callTool({ name: "vault_stats", arguments: {} });
    step(
      "reconcile: the agent key keeps working (vault_id-scoped, followed the vault)",
      reconcileStatsAfter.isError !== true,
    );
    await reconcileMcp.close();

    // 13c. a third anonymous signup stays UNCLAIMED for the expiry journey (§20).
    const expiryRes = await pub.callTool({ name: "signup", arguments: { vaultName: "Expiring Vault" } });
    const expiryPayload = JSON.parse(expiryRes.content.find((c) => c.type === "text").text);
    step(
      "expiry-journey signup succeeds (left unclaimed)",
      expiryRes.isError !== true && /^bz_/.test(expiryPayload.apiKey ?? ""),
    );
    const expiringKey = expiryPayload.apiKey;

    // 14. per-IP rate limit (5/hour): FOUR signups so far from this IP —
    // §12 anonymous, §13b decline, §13d reconcile, §13c expiry — so exactly one
    // more passes (the 5th) and the 6th trips.
    let more = true;
    for (let i = 5; i <= 5; i++) {
      const r = await pub.callTool({ name: "signup", arguments: { vaultName: `Filler ${i}` } });
      if (r.isError) more = false;
    }
    step("the 5th signup from the same IP within the hour still succeeds", more);
    const sixth = await pub.callTool({ name: "signup", arguments: {} });
    const sixthText = sixth.content.find((c) => c.type === "text")?.text ?? "";
    step(
      "6th signup from the same IP within the hour → rate-limit isError",
      sixth.isError === true && /rate limit/i.test(sixthText),
      sixthText.slice(0, 90),
    );
    await pub.close();

    // 15. only ABSENT auth gets the public server — invalid bearers still 401
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } },
    });
    const unknownBearer = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer bz_00000000000000000000000000000000",
      },
      body: initBody,
    });
    step("unknown bearer on /mcp still → 401", unknownBearer.status === 401, `status ${unknownBearer.status}`);
    const malformedBearer = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer garbage" },
      body: "{}",
    });
    step("malformed bearer on /mcp still → 401", malformedBearer.status === 401, `status ${malformedBearer.status}`);

    // ================================================================
    // 16. TENANCY PROBES — the load-bearing isolation guarantees.
    // A second user's session and user A's bearer key must never be able
    // to read or mutate vault A beyond their grant; foreign vaults are
    // indistinguishable from missing ones (404).
    // ================================================================

    // "User B" is minted passwordlessly — a fresh magic link followed into its
    // own cookie jar. There is no sign-up/email endpoint any more; the link IS
    // the account creation + sign-in for an as-yet-unknown address.
    const jarB = new Map();
    const bLogin = await signInViaMagicLink(`e2e-b-${Date.now()}@example.com`, jarB);
    step(
      "tenancy: second user signs in via magic link → own session cookie",
      bLogin.ok && jarB.size > 0,
      bLogin.ok ? [...jarB.keys()].join(", ") : `failed at ${bLogin.reason} (status ${bLogin.status})`,
    );

    const bVaults = await api("GET", "/api/vaults", { jar: jarB });
    step(
      "tenancy: user B's vault list is empty (no leakage of A's vaults)",
      bVaults.status === 200 && bVaults.json?.vaults?.length === 0,
      JSON.stringify(bVaults.json?.vaults?.map((v) => v.slug)),
    );

    // Every route class, both reads and writes, against A's vault as B → 404.
    const tenancyProbes = [
      ["GET", `/api/vaults/${vaultId}`, undefined],
      ["PATCH", `/api/vaults/${vaultId}`, { name: "hijacked" }],
      ["DELETE", `/api/vaults/${vaultId}`, undefined],
      ["GET", `/api/vaults/${vaultId}/stats`, undefined],
      ["GET", `/api/vaults/${vaultId}/graph`, undefined],
      ["GET", `/api/vaults/${vaultId}/search?q=auth`, undefined],
      ["GET", `/api/vaults/${vaultId}/related/auth-system`, undefined],
      ["POST", `/api/vaults/${vaultId}/context`, { query: "auth" }],
      ["GET", `/api/vaults/${vaultId}/concepts`, undefined],
      ["POST", `/api/vaults/${vaultId}/concepts`, { title: "Injected", body: "planted by B" }],
      ["GET", `/api/vaults/${vaultId}/concepts/auth-system`, undefined],
      ["PUT", `/api/vaults/${vaultId}/concepts/auth-system`, { title: "Defaced", body: "overwritten by B" }],
      ["DELETE", `/api/vaults/${vaultId}/concepts/auth-system`, undefined],
      ["GET", `/api/vaults/${vaultId}/keys`, undefined],
      ["POST", `/api/vaults/${vaultId}/keys`, { name: "stolen-key" }],
      ["GET", `/api/vaults/${vaultId}/types`, undefined],
      ["POST", `/api/vaults/${vaultId}/types`, { key: "x", label: "X", color: "#fff" }],
      ["PATCH", `/api/vaults/${vaultId}/types/domain`, { weight: 5 }],
      ["DELETE", `/api/vaults/${vaultId}/types/domain`, undefined],
    ];
    for (const [method, probePath, body] of tenancyProbes) {
      const res = await api(method, probePath, { body, jar: jarB });
      step(
        `tenancy: B ${method} ${probePath.replace(vaultId, ":vaultA")} → 404`,
        res.status === 404,
        `status ${res.status}`,
      );
    }

    // The probes changed nothing: A still reads the original concept + vault name.
    const untouched = await api("GET", `/api/vaults/${vaultId}/concepts/auth-system`);
    step(
      "tenancy: A's concept survives B's probes intact",
      untouched.status === 200 && untouched.json?.title === "Auth system",
      `status ${untouched.status} title=${untouched.json?.title}`,
    );
    const vaultStill = await api("GET", `/api/vaults/${vaultId}`);
    step(
      "tenancy: A's vault name/slug survive B's probes",
      vaultStill.json?.name === "E2E Vault" && vaultStill.json?.slug === "e2e-vault",
      `${vaultStill.json?.name} / ${vaultStill.json?.slug}`,
    );

    // B cannot revoke A's key: mint a fresh key for A, probe, verify it survives.
    const keyA2 = await api("POST", `/api/vaults/${vaultId}/keys`, { body: { name: "post-revoke-key" } });
    step("tenancy setup: A mints a fresh key → 201", keyA2.status === 201, `status ${keyA2.status}`);
    const bRevokes = await api("DELETE", `/api/keys/${keyA2.json.id}`, { jar: jarB });
    step("tenancy: B DELETE /api/keys/:aKeyId → 404", bRevokes.status === 404, `status ${bRevokes.status}`);
    const aKeys = await api("GET", `/api/vaults/${vaultId}/keys`);
    step(
      "tenancy: A's key survives B's revoke attempt",
      aKeys.json?.keys?.some((k) => k.id === keyA2.json.id),
      JSON.stringify(aKeys.json?.keys?.map((k) => k.name)),
    );

    // Bearer keys are data-plane only (sessionOnly routes reject them)…
    const bearerA2 = keyA2.json.key;
    const bearerPatch = await api("PATCH", `/api/vaults/${vaultId}`, { cookie: false, bearer: bearerA2, body: { name: "renamed-by-key" } });
    step("tenancy: bearer PATCH own vault → 401 (session-only)", bearerPatch.status === 401, `status ${bearerPatch.status}`);
    const bearerDelete = await api("DELETE", `/api/vaults/${vaultId}`, { cookie: false, bearer: bearerA2 });
    step("tenancy: bearer DELETE own vault → 401 (session-only)", bearerDelete.status === 401, `status ${bearerDelete.status}`);
    const bearerKeyList = await api("GET", `/api/vaults/${vaultId}/keys`, { cookie: false, bearer: bearerA2 });
    step("tenancy: bearer GET keys → 401 (session-only)", bearerKeyList.status === 401, `status ${bearerKeyList.status}`);
    const bearerRevoke = await api("DELETE", `/api/keys/${keyA2.json.id}`, { cookie: false, bearer: bearerA2 });
    step("tenancy: bearer DELETE /api/keys/:id → 401 (session-only)", bearerRevoke.status === 401, `status ${bearerRevoke.status}`);
    // …and B's foreign vault stays 404 for writes through the key too.
    const bearerForeignWrite = await api("POST", `/api/vaults/${other.json.id}/concepts`, {
      cookie: false,
      bearer: bearerA2,
      body: { title: "Cross-vault write", body: "must not land" },
    });
    step("tenancy: A's key POST concepts to A's OTHER vault → 404 (key ≠ owner)", bearerForeignWrite.status === 404, `status ${bearerForeignWrite.status}`);

    // Anonymous requests to the data plane are 401, not 404 (no auth at all).
    for (const [method, probePath, body] of [
      ["GET", `/api/vaults/${vaultId}/stats`, undefined],
      ["POST", `/api/vaults/${vaultId}/concepts`, { title: "anon", body: "x" }],
      ["POST", `/api/vaults/${vaultId}/context`, { query: "auth" }],
    ]) {
      const res = await api(method, probePath, { cookie: false, body });
      step(`anon ${method} ${probePath.replace(vaultId, ":vaultA")} → 401`, res.status === 401, `status ${res.status}`);
    }

    // ================================================================
    // 16b. PUBLIC VAULTS — anonymous read-only via an unguessable token.
    //   owner enables → gets a /public/<token> link → anonymous browser sees
    //   the read-only graph; anonymous MCP with the token can search/get_context
    //   but NOT write; members/keys/invites are NEVER exposed publicly (probe);
    //   rotate invalidates the old token; disable 404s it; a random/non-public
    //   token → 404 (web) / 401 (MCP); per-IP rate limit on anon MCP reads.
    // vaultId is onboarded with concepts (incl. lead-scoring) by this point.
    // ================================================================

    // Before enabling, an owner-only status read reports disabled; and a random
    // token 404s at the web route (non-enumerable) and 401s at MCP.
    const preStatus = await api("GET", `/api/vaults/${vaultId}/public`);
    step(
      "public status pre-enable → { enabled:false }",
      preStatus.status === 200 &&
        publicStatusSchema.safeParse(preStatus.json).success &&
        preStatus.json.enabled === false,
      JSON.stringify(preStatus.json),
    );
    const randomToken = "f".repeat(64);
    const randomPage = await fetch(`${BASE}/public/${randomToken}`, { headers: { origin: BASE } });
    step("a random /public/<token> page → 404 (non-enumerable)", randomPage.status === 404, `status ${randomPage.status}`);
    const randomGraph = await api("GET", `/api/public/${randomToken}/graph`, { cookie: false });
    step("a random public REST token → 404", randomGraph.status === 404, `status ${randomGraph.status}`);

    // Enable public access (owner-only) → the one-time token + /public/<token> URL.
    const enablePub = await api("POST", `/api/vaults/${vaultId}/public`);
    step("owner enables public access → 201 { token, url }", enablePub.status === 201, `status ${enablePub.status}`);
    assertParse(publicEnableResponseSchema, enablePub.json, "public enable response parses ({enabled,token,url,createdAt})");
    const pubToken = enablePub.json?.token;
    step("public token is a 64-hex unguessable string", /^[0-9a-f]{64}$/.test(pubToken ?? ""), (pubToken ?? "").slice(0, 12));
    step(
      "public url is /public/<token>",
      typeof enablePub.json?.url === "string" && enablePub.json.url.endsWith(`/public/${pubToken}`),
      enablePub.json?.url,
    );

    // A NON-owner (user B) cannot enable/read/manage public access → 404.
    const bEnable = await api("POST", `/api/vaults/${vaultId}/public`, { jar: jarB });
    step("non-member cannot enable public access → 404", bEnable.status === 404, `status ${bEnable.status}`);
    const bStatus = await api("GET", `/api/vaults/${vaultId}/public`, { jar: jarB });
    step("non-member cannot read public status → 404", bStatus.status === 404, `status ${bStatus.status}`);
    // A bearer key is session-only here (like keys/members/invites).
    const keyEnable = await api("POST", `/api/vaults/${vaultId}/public`, { cookie: false, bearer: bearerA2 });
    step("bearer key cannot manage public access → 401 (session-only)", keyEnable.status === 401, `status ${keyEnable.status}`);

    // Anonymous web page renders the vault name + a concept (read-only), and
    // carries the "public read-only" banner + sign-up affordance.
    const pubPage = await fetch(`${BASE}/public/${pubToken}`, { headers: { origin: BASE } });
    const pubPageHtml = await pubPage.text();
    step(
      "anonymous /public/<token> renders the read-only workspace (vault name + concept + banner)",
      pubPage.status === 200 &&
        pubPageHtml.includes("Auth system") &&
        /public read-only/i.test(pubPageHtml) &&
        pubPageHtml.includes("read-only"),
      `status ${pubPage.status}`,
    );

    // Anonymous public REST reads (no session, no bearer) work.
    const pubGraph = await api("GET", `/api/public/${pubToken}/graph`, { cookie: false });
    step("anonymous public graph → 200 and parses", pubGraph.status === 200 && graphResponseSchema.safeParse(pubGraph.json).success, `status ${pubGraph.status}`);
    const pubStats = await api("GET", `/api/public/${pubToken}/stats`, { cookie: false });
    step("anonymous public stats → 200 and parses", pubStats.status === 200 && statsResponseSchema.safeParse(pubStats.json).success, `status ${pubStats.status}`);
    const pubSearch = await api("GET", `/api/public/${pubToken}/search?q=auth`, { cookie: false });
    step("anonymous public search → 200 and parses", pubSearch.status === 200 && searchResponseSchema.safeParse(pubSearch.json).success, `status ${pubSearch.status}`);
    const pubConcept = await api("GET", `/api/public/${pubToken}/concepts/auth-system`, { cookie: false });
    step("anonymous public concept read → 200", pubConcept.status === 200 && pubConcept.json?.title === "Auth system", `status ${pubConcept.status}`);
    const pubCtx = await api("POST", `/api/public/${pubToken}/context`, { cookie: false, body: { query: "auth" } });
    step("anonymous public context → 200 and parses", pubCtx.status === 200 && contextResponseSchema.safeParse(pubCtx.json).success, `status ${pubCtx.status}`);

    // TENANCY: the public surface NEVER exposes members/keys/invites or any
    // write route — those public paths simply do not exist (→ 404). And a public
    // read must not mutate: there is no public write route at all.
    for (const p of [
      `/api/public/${pubToken}/members`,
      `/api/public/${pubToken}/keys`,
      `/api/public/${pubToken}/invites`,
    ]) {
      const res = await api("GET", p, { cookie: false });
      step(`public surface has NO ${p.replace(pubToken, "<token>")} → 404`, res.status === 404, `status ${res.status}`);
    }
    // A public write attempt on the public concept path is not routed → 404/405.
    const pubWrite = await api("PUT", `/api/public/${pubToken}/concepts/auth-system`, { cookie: false, body: { title: "hijacked", body: "x" } });
    step("public concept path has no write verb → not 2xx", pubWrite.status >= 400, `status ${pubWrite.status}`);
    // The public token must NOT unlock the authenticated /api/vaults/:id surface
    // (it is not a bz_ key): members/keys as a bearer → 401.
    const tokenAsBearerMembers = await api("GET", `/api/vaults/${vaultId}/members`, { cookie: false, bearer: pubToken });
    step("public token as a bearer on /api/vaults/:id/members → 401 (never exposes members)", tokenAsBearerMembers.status === 401, `status ${tokenAsBearerMembers.status}`);
    const tokenAsBearerKeys = await api("GET", `/api/vaults/${vaultId}/keys`, { cookie: false, bearer: pubToken });
    step("public token as a bearer on /api/vaults/:id/keys → 401 (never exposes keys)", tokenAsBearerKeys.status === 401, `status ${tokenAsBearerKeys.status}`);

    // Anonymous MCP with the public token: read tools ONLY, no writes.
    const pubMcpTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${pubToken}` } },
    });
    const pubMcp = new Client({ name: "brainz-e2e-public-read", version: "0.0.0" });
    await pubMcp.connect(pubMcpTransport);
    step("MCP connect with a public token succeeds (anonymous viewer)", true);
    const pubMcpTools = (await pubMcp.listTools()).tools.map((t) => t.name).sort();
    step(
      "public MCP tools/list is EXACTLY the read tools — no write/onboard/task/claim/signup",
      JSON.stringify(pubMcpTools) === JSON.stringify([...PUBLIC_VAULT_READ_TOOL_NAMES].sort()) &&
        !pubMcpTools.some((n) => ["upsert_concept", "delete_concept", "link_concepts", "onboard", "create_task", "take_task", "complete_task", "list_tasks", "claim", "signup", "sign_in"].includes(n)),
      pubMcpTools.join(", "),
    );
    const pubMcpSearch = await pubMcp.callTool({ name: "search_concepts", arguments: { query: "auth" } });
    step("public MCP search_concepts works", pubMcpSearch.isError !== true);
    const pubMcpCtx = await pubMcp.callTool({ name: "get_context", arguments: { query: "auth" } });
    step("public MCP get_context works (two-block bundle)", pubMcpCtx.isError !== true && pubMcpCtx.content.filter((c) => c.type === "text").length === 2);
    // Write tools are not registered → calling one is an error, and nothing writes.
    const pubMcpWrite = await pubMcp.callTool({ name: "upsert_concept", arguments: { title: "hijack", body: "x" } });
    step("public MCP upsert_concept is blocked (tool not found / error)", pubMcpWrite.isError === true, (pubMcpWrite.content?.find?.((c) => c.type === "text")?.text ?? "").slice(0, 60));
    const pubMcpTake = await pubMcp.callTool({ name: "take_task", arguments: {} });
    step("public MCP take_task is blocked (tool not found / error)", pubMcpTake.isError === true);
    await pubMcp.close();
    // The write attempt landed nothing: the concept count is unchanged for the owner.
    const afterProbeStats = await api("GET", `/api/vaults/${vaultId}/stats`);
    step("public write probes changed nothing (owner still reads the vault)", afterProbeStats.status === 200, `status ${afterProbeStats.status}`);
    const hijackGone = await api("GET", `/api/vaults/${vaultId}/concepts/hijack`);
    step("no concept was planted by the public write probes → 404", hijackGone.status === 404, `status ${hijackGone.status}`);

    // ROTATE invalidates the old token; the new one works.
    const rotatePub = await api("POST", `/api/vaults/${vaultId}/public/rotate`);
    step("owner rotates the public token → 200 { token, url }", rotatePub.status === 200 && publicEnableResponseSchema.safeParse(rotatePub.json).success, `status ${rotatePub.status}`);
    const rotatedToken = rotatePub.json?.token;
    step("the rotated token DIFFERS from the original", Boolean(rotatedToken) && rotatedToken !== pubToken);
    const oldTokenPage = await fetch(`${BASE}/public/${pubToken}`, { headers: { origin: BASE } });
    step("the OLD public link is dead after rotate → 404", oldTokenPage.status === 404, `status ${oldTokenPage.status}`);
    const oldTokenGraph = await api("GET", `/api/public/${pubToken}/graph`, { cookie: false });
    step("the OLD public REST token is dead after rotate → 404", oldTokenGraph.status === 404, `status ${oldTokenGraph.status}`);
    const oldTokenMcp = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${pubToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    step("the OLD public token on /mcp is dead after rotate → 401", oldTokenMcp.status === 401, `status ${oldTokenMcp.status}`);
    const newTokenGraph = await api("GET", `/api/public/${rotatedToken}/graph`, { cookie: false });
    step("the ROTATED public REST token works → 200", newTokenGraph.status === 200, `status ${newTokenGraph.status}`);

    // DISABLE revokes: the current link 404s everywhere.
    const disablePub = await api("DELETE", `/api/vaults/${vaultId}/public`);
    step("owner disables public access → 204", disablePub.status === 204, `status ${disablePub.status}`);
    const disabledPage = await fetch(`${BASE}/public/${rotatedToken}`, { headers: { origin: BASE } });
    step("after disable, the public page → 404", disabledPage.status === 404, `status ${disabledPage.status}`);
    const disabledGraph = await api("GET", `/api/public/${rotatedToken}/graph`, { cookie: false });
    step("after disable, the public REST token → 404", disabledGraph.status === 404, `status ${disabledGraph.status}`);
    const disabledMcp = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rotatedToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    step("after disable, the public token on /mcp → 401", disabledMcp.status === 401, `status ${disabledMcp.status}`);
    const disabledStatus = await api("GET", `/api/vaults/${vaultId}/public`);
    step("status after disable → { enabled:false }", disabledStatus.status === 200 && disabledStatus.json?.enabled === false, JSON.stringify(disabledStatus.json));

    // Per-IP rate limit on anonymous MCP reads: re-enable, then hammer initialize
    // from ONE IP past the cap and assert a 429 eventually trips. (The cap is
    // generous — 120/hr — so we send just over it with a dedicated IP.)
    const reEnable = await api("POST", `/api/vaults/${vaultId}/public`);
    const rlToken = reEnable.json?.token;
    const RL_IP = "203.0.113.99";
    const initBodyPub = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
    let pubRateLimited = false;
    for (let i = 0; i < 130; i++) {
      const r = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rlToken}`, "cf-connecting-ip": RL_IP },
        body: initBodyPub,
      });
      if (r.status === 429) { pubRateLimited = true; break; }
    }
    step("anonymous public MCP reads are per-IP rate-limited (429 past the cap)", pubRateLimited);
    // Clean up so §18/§20 see the vault in a plain state.
    await api("DELETE", `/api/vaults/${vaultId}/public`);

    // ================================================================
    // 17. VALIDATION FAILURES — every parse boundary answers 400 with {error}.
    // ================================================================

    const badBodies = [
      ["POST", "/api/vaults", {}, "vault create without name"],
      ["POST", "/api/vaults", { name: "" }, "vault create with empty name"],
      ["POST", `/api/vaults/${vaultId}/concepts`, { title: "No body here" }, "concept without body"],
      // NOTE (Wave TR): an unknown `type` is NO LONGER a 400 — it's registry-
      // validated and falls back to "concept" (asserted in §7b above), so it's
      // deliberately absent from this parse-failure list.
      ["PUT", `/api/vaults/${vaultId}/concepts/auth-system`, { id: "different-id", title: "x", body: "y" }, "concept PUT with mismatched body id"],
      ["POST", `/api/vaults/${vaultId}/context`, {}, "context without query or ids"],
      ["POST", `/api/vaults/${vaultId}/keys`, {}, "key create without name"],
      ["POST", `/api/vaults/${vaultId}/keys`, { name: "" }, "key create with empty name"],
    ];
    for (const [method, badPath, body, label] of badBodies) {
      const res = await api(method, badPath, { body });
      step(
        `validation: ${label} → 400 {error}`,
        res.status === 400 && typeof res.json?.error === "string",
        `status ${res.status}`,
      );
    }

    const badQueries = [
      [`/api/vaults/${vaultId}/search`, "search without q"],
      [`/api/vaults/${vaultId}/search?q=x&limit=999`, "search with limit over 50"],
      [`/api/vaults/${vaultId}/search?q=x&mode=psychic`, "search with unknown mode"],
      [`/api/vaults/${vaultId}/related/auth-system?depth=9`, "related with depth over 3"],
    ];
    for (const [badPath, label] of badQueries) {
      const res = await api("GET", badPath);
      step(
        `validation: ${label} → 400 {error}`,
        res.status === 400 && typeof res.json?.error === "string",
        `status ${res.status}`,
      );
    }

    const rawInvalid = await fetch(`${BASE}/api/vaults/${vaultId}/context`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", cookie: cookieHeader() },
      body: "this is not json",
    });
    step("validation: non-JSON body → 400", rawInvalid.status === 400, `status ${rawInvalid.status}`);

    const dupVault = await api("POST", "/api/vaults", { body: { name: "E2E Vault" } });
    step("validation: duplicate vault slug → 409", dupVault.status === 409, `status ${dupVault.status}`);

    // ================================================================
    // 17b. VAULT MEMBERSHIP + EMAIL INVITE (Wave M) — the primary session
    //      (owner of `vaultId`) invites a colleague as VIEWER, the colleague
    //      signs in via magic link and accepts, becoming a member; then role
    //      enforcement is exercised (viewer cannot write; non-member 404).
    // ================================================================

    // The owner sees exactly themselves as an owner member to start.
    const membersBefore = await api("GET", `/api/vaults/${vaultId}/members`);
    step(
      "owner lists members: one owner (self) via the backfilled/created membership",
      membersBefore.status === 200 &&
        membersBefore.json?.members?.length === 1 &&
        membersBefore.json.members[0].role === "owner",
      `status ${membersBefore.status}, ${membersBefore.json?.members?.length} member(s)`,
    );

    // Route this journey's email sends through a DEDICATED client IP so the two
    // invite/sign-in emails don't draw down the shared "local" IP bucket that
    // the magic-link rate-limit + normalization sections below depend on.
    const INVITE_IP = "203.0.113.77";
    const colleagueEmail = `colleague-${Date.now()}@example.com`;
    const inviteMarker = devLog.length;
    const inviteResFetch = await fetch(`${BASE}/api/vaults/${vaultId}/invites`, {
      method: "POST",
      headers: {
        origin: BASE,
        "content-type": "application/json",
        cookie: cookieHeader(),
        "cf-connecting-ip": INVITE_IP,
      },
      body: JSON.stringify({ email: colleagueEmail, role: "viewer" }),
    });
    const inviteRes = { status: inviteResFetch.status, json: await inviteResFetch.json() };
    step(
      "owner creates a viewer invite → 201 {invite, url}",
      inviteRes.status === 201 &&
        inviteRes.json?.invite?.email === colleagueEmail &&
        inviteRes.json?.invite?.role === "viewer" &&
        typeof inviteRes.json?.url === "string",
      `status ${inviteRes.status}`,
    );

    // The invite email was delivered (DevMailer/miniflare) — capture its link.
    const invitedUrl = await captureInviteLink(colleagueEmail, inviteMarker);
    step(
      "invite email delivered with an /invite/<token> link (captured)",
      Boolean(invitedUrl) && /\/invite\/[0-9a-f]{64}/.test(invitedUrl ?? ""),
      (invitedUrl ?? "").slice(0, 60),
    );
    const invitePath = invitedUrl ? new URL(invitedUrl, BASE).pathname : "";

    // The colleague signs in (passwordless) as the invited address.
    const colleagueJar = new Map();
    const colleagueLogin = await signInViaMagicLink(colleagueEmail, colleagueJar, {
      "cf-connecting-ip": INVITE_IP,
    });
    step("colleague signs in via magic link (session cookie)", colleagueLogin.ok, colleagueLogin.reason);
    const colleagueCookie = cookieHeader(colleagueJar);

    // Before accepting, the colleague is a NON-member of the vault → 404.
    const preAccept = await fetch(`${BASE}/api/vaults/${vaultId}/stats`, {
      headers: { origin: BASE, cookie: colleagueCookie },
    });
    step(
      "non-member colleague probing the vault → 404 (no tenancy leak)",
      preAccept.status === 404,
      `status ${preAccept.status}`,
    );

    // Accept via the invite page's form action (plain-browser 303 flow).
    const acceptRes = await fetch(`${BASE}${invitePath}?/accept`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: BASE,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: colleagueCookie,
      },
      body: "",
    });
    step(
      "accepting the invite 303-redirects into the vault",
      acceptRes.status === 303 && /\/v\//.test(acceptRes.headers.get("location") ?? ""),
      `status ${acceptRes.status} → ${(acceptRes.headers.get("location") ?? "").slice(0, 40)}`,
    );

    // Now a MEMBER: reads work (viewer scope) …
    const colleagueStats = await fetch(`${BASE}/api/vaults/${vaultId}/stats`, {
      headers: { origin: BASE, cookie: colleagueCookie },
    });
    step("accepted colleague can now read the vault (viewer)", colleagueStats.status === 200, `status ${colleagueStats.status}`);

    // … but WRITES are refused (viewer is read-only) → 403.
    const viewerWrite = await fetch(`${BASE}/api/vaults/${vaultId}/concepts`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", cookie: colleagueCookie },
      body: JSON.stringify({ id: "viewer-should-not-write", title: "nope", type: "note", body: "x" }),
    });
    step("viewer write is refused → 403 (read-only role)", viewerWrite.status === 403, `status ${viewerWrite.status}`);

    // Concept-type registry role gating: a viewer may READ the types …
    const viewerTypes = await fetch(`${BASE}/api/vaults/${vaultId}/types`, {
      headers: { origin: BASE, cookie: colleagueCookie },
    });
    step("viewer can read concept types (200)", viewerTypes.status === 200, `status ${viewerTypes.status}`);
    // … but not CREATE or PATCH one (editor+).
    const viewerCreateType = await fetch(`${BASE}/api/vaults/${vaultId}/types`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", cookie: colleagueCookie },
      body: JSON.stringify({ key: "sneaky", label: "Sneaky", color: "#fff" }),
    });
    step("viewer cannot create a type → 403", viewerCreateType.status === 403, `status ${viewerCreateType.status}`);
    const viewerPatchType = await fetch(`${BASE}/api/vaults/${vaultId}/types/domain`, {
      method: "PATCH",
      headers: { origin: BASE, "content-type": "application/json", cookie: colleagueCookie },
      body: JSON.stringify({ weight: 1 }),
    });
    step("viewer cannot patch a type → 403", viewerPatchType.status === 403, `status ${viewerPatchType.status}`);

    // The owner now sees two members; the invite is consumed (no longer pending).
    const membersAfter = await api("GET", `/api/vaults/${vaultId}/members`);
    step(
      "owner lists members: now owner + viewer",
      membersAfter.status === 200 &&
        membersAfter.json?.members?.length === 2 &&
        membersAfter.json.members.some((m) => m.email === colleagueEmail && m.role === "viewer"),
      `status ${membersAfter.status}, ${membersAfter.json?.members?.length} member(s)`,
    );
    const pendingAfter = await api("GET", `/api/vaults/${vaultId}/invites`);
    step(
      "the accepted invite is consumed (no longer pending)",
      pendingAfter.status === 200 && (pendingAfter.json?.invites ?? []).length === 0,
      `status ${pendingAfter.status}, ${pendingAfter.json?.invites?.length} pending`,
    );

    // Single-use: replaying the same accept token fails (already used → 410).
    const replay = await fetch(`${BASE}${invitePath}?/accept`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: BASE,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        cookie: colleagueCookie,
      },
      body: "",
    });
    step("replaying a consumed invite token fails (not another 303)", replay.status !== 303, `status ${replay.status}`);

    // Owner-only surface: the viewer cannot invite or list keys.
    const viewerInvite = await fetch(`${BASE}/api/vaults/${vaultId}/invites`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", cookie: colleagueCookie },
      body: JSON.stringify({ email: "someone@example.com", role: "editor" }),
    });
    step("viewer cannot create invites → 403 (owner-only)", viewerInvite.status === 403, `status ${viewerInvite.status}`);

    // ================================================================
    // 17c. MEMBERSHIP ADMIN (Wave M) — the EDITOR journey, role gates on the
    //      admin plane, role change, last-owner protection, remove/self-leave,
    //      and invite mismatch/revoke/resend. Emails ride DEDICATED client IPs
    //      (see §17b) so the shared "local" bucket stays intact for §19.
    // ================================================================
    const ADMIN_IP = "203.0.113.78";
    const inviteApi = (method, p, body, jar = null) =>
      fetch(`${BASE}${p}`, {
        method,
        headers: {
          origin: BASE,
          "content-type": "application/json",
          cookie: jar ? cookieHeader(jar) : cookieHeader(),
          "cf-connecting-ip": ADMIN_IP,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

    // --- invite an EDITOR; the list schema parses and never leaks the token.
    const editor2Email = `editor2-${Date.now()}@example.com`;
    const editor2Marker = devLog.length;
    const editor2Invite = await inviteApi("POST", `/api/vaults/${vaultId}/invites`, {
      email: editor2Email.toUpperCase(), // mixed-case in → normalized at rest
      role: "editor",
    });
    step("editor invite → 201", editor2Invite.status === 201, `status ${editor2Invite.status}`);
    assertParse(inviteCreateResponseSchema, editor2Invite.json, "invite create response parses ({invite, url})");
    step(
      "invite email is stored normalized-lowercase (shared choke-point)",
      editor2Invite.json?.invite?.email === editor2Email,
      editor2Invite.json?.invite?.email,
    );
    const editor2Token = new URL(editor2Invite.json.url, BASE).pathname.split("/invite/")[1];
    const editor2Emailed = await captureInviteLink(editor2Email, editor2Marker);
    step(
      "the editor invite was EMAILED — capture matches the one-time url",
      Boolean(editor2Emailed) && editor2Emailed.includes(editor2Token),
      (editor2Emailed ?? "").slice(0, 60),
    );
    const pendingList = await api("GET", `/api/vaults/${vaultId}/invites`);
    assertParse(inviteListResponseSchema, pendingList.json, "invite list parses with contract schema");
    step(
      "the pending list carries NO url and NO token (hashed at rest — url shown once)",
      pendingList.json?.invites?.some((i) => i.email === editor2Email) &&
        !JSON.stringify(pendingList.json).includes(editor2Token) &&
        !/"url"/.test(JSON.stringify(pendingList.json)),
      JSON.stringify(pendingList.json?.invites?.map((i) => i.email)),
    );

    // MISMATCH first: the colleague (viewer, WRONG address) cannot take it.
    const mismatchAccept = await inviteApi(
      "POST",
      `/api/invites/${editor2Token}/accept`,
      undefined,
      colleagueJar,
    );
    step(
      "accepting with the WRONG signed-in email → 403 naming both addresses",
      mismatchAccept.status === 403 &&
        (mismatchAccept.json?.error ?? "").includes(editor2Email) &&
        (mismatchAccept.json?.error ?? "").includes(colleagueEmail),
      `status ${mismatchAccept.status} — ${(mismatchAccept.json?.error ?? "").slice(0, 90)}`,
    );

    // The RIGHT address signs in and accepts over REST.
    const editor2Jar = new Map();
    const editor2Login = await signInViaMagicLink(editor2Email, editor2Jar, {
      "cf-connecting-ip": ADMIN_IP,
    });
    step("editor signs in via magic link", editor2Login.ok, editor2Login.reason);
    const editor2Accept = await inviteApi(
      "POST",
      `/api/invites/${editor2Token}/accept`,
      undefined,
      editor2Jar,
    );
    step("editor accepts the invite → 200", editor2Accept.status === 200, `status ${editor2Accept.status}`);
    assertParse(inviteAcceptResponseSchema, editor2Accept.json, "invite accept response parses");
    step(
      "accept grants the invite's role on the right vault",
      editor2Accept.json?.vaultId === vaultId &&
        editor2Accept.json?.role === "editor" &&
        editor2Accept.json?.alreadyMember === false,
      JSON.stringify(editor2Accept.json),
    );

    // --- EDITOR powers: session writes YES; admin surfaces NO.
    const editor2Vaults = await api("GET", "/api/vaults", { jar: editor2Jar });
    step(
      "GET /api/vaults lists by MEMBERSHIP with the caller's role (editor) + memberCount",
      editor2Vaults.status === 200 &&
        editor2Vaults.json?.vaults?.some(
          (v) => v.id === vaultId && v.role === "editor" && v.memberCount === 3,
        ),
      JSON.stringify(editor2Vaults.json?.vaults?.map((v) => `${v.slug}:${v.role}:${v.memberCount}`)),
    );
    const editorUpsert = await api("POST", `/api/vaults/${vaultId}/concepts`, {
      jar: editor2Jar,
      body: { id: "editor-written-note", title: "Editor note", body: "written by the invited editor" },
    });
    step("editor CAN upsert concepts via session → 201", editorUpsert.status === 201, `status ${editorUpsert.status}`);
    for (const [method, p, body, label] of [
      ["GET", `/api/vaults/${vaultId}/keys`, undefined, "list keys"],
      ["POST", `/api/vaults/${vaultId}/keys`, { name: "sneaky" }, "mint a key"],
      ["GET", `/api/vaults/${vaultId}/invites`, undefined, "list invites"],
      ["POST", `/api/vaults/${vaultId}/invites`, { email: "x@example.com", role: "viewer" }, "create an invite"],
      ["PATCH", `/api/vaults/${vaultId}`, { name: "renamed-by-editor" }, "rename the vault"],
      ["DELETE", `/api/vaults/${vaultId}`, undefined, "delete the vault"],
    ]) {
      const res = await api(method, p, { body, jar: editor2Jar });
      step(`editor cannot ${label} → 403`, res.status === 403, `status ${res.status}`);
    }
    const editorMembersRead = await api("GET", `/api/vaults/${vaultId}/members`, { jar: editor2Jar });
    assertParse(memberListResponseSchema, editorMembersRead.json, "members list (as editor) parses");
    step(
      "any member can read the roster (owner + viewer + editor = 3)",
      editorMembersRead.status === 200 && editorMembersRead.json?.members?.length === 3,
      `status ${editorMembersRead.status}, ${editorMembersRead.json?.members?.length} member(s)`,
    );
    const ownerUserId = editorMembersRead.json.members.find((m) => m.role === "owner")?.userId;
    const colleagueUserId = editorMembersRead.json.members.find((m) => m.email === colleagueEmail)?.userId;
    const editor2UserId = editorMembersRead.json.members.find((m) => m.email === editor2Email)?.userId;

    // --- role change: owner-only; takes effect immediately.
    const editorTriesRoleChange = await api("PATCH", `/api/vaults/${vaultId}/members/${colleagueUserId}`, {
      jar: editor2Jar,
      body: { role: "editor" },
    });
    step("an editor cannot change roles → 403 (owner-only)", editorTriesRoleChange.status === 403, `status ${editorTriesRoleChange.status}`);
    const promoteColleague = await api("PATCH", `/api/vaults/${vaultId}/members/${colleagueUserId}`, {
      body: { role: "editor" },
    });
    step(
      "owner promotes the viewer to editor → 200 with the updated member",
      promoteColleague.status === 200 && promoteColleague.json?.role === "editor",
      `status ${promoteColleague.status} role=${promoteColleague.json?.role}`,
    );
    const promotedWrite = await fetch(`${BASE}/api/vaults/${vaultId}/concepts`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", cookie: cookieHeader(colleagueJar) },
      body: JSON.stringify({ title: "Promoted note", body: "the promoted member can write now" }),
    });
    step("the promoted member can write immediately → 201", promotedWrite.status === 201, `status ${promotedWrite.status}`);
    const demoteColleague = await api("PATCH", `/api/vaults/${vaultId}/members/${colleagueUserId}`, {
      body: { role: "viewer" },
    });
    step("owner demotes back to viewer → 200", demoteColleague.status === 200 && demoteColleague.json?.role === "viewer", `status ${demoteColleague.status}`);
    const demotedWrite = await fetch(`${BASE}/api/vaults/${vaultId}/concepts`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", cookie: cookieHeader(colleagueJar) },
      body: JSON.stringify({ title: "Planted", body: "demoted viewer must not write" }),
    });
    step("the demoted member is read-only again → 403", demotedWrite.status === 403, `status ${demotedWrite.status}`);

    // --- LAST-OWNER protection: cannot be demoted, removed, or leave.
    const demoteLastOwner = await api("PATCH", `/api/vaults/${vaultId}/members/${ownerUserId}`, {
      body: { role: "editor" },
    });
    step(
      "demoting the LAST owner → 409",
      demoteLastOwner.status === 409 && /last owner/.test(demoteLastOwner.json?.error ?? ""),
      `status ${demoteLastOwner.status} — ${(demoteLastOwner.json?.error ?? "").slice(0, 70)}`,
    );
    const lastOwnerLeaves = await api("DELETE", `/api/vaults/${vaultId}/members/${ownerUserId}`);
    step("the LAST owner cannot leave → 409", lastOwnerLeaves.status === 409, `status ${lastOwnerLeaves.status}`);

    // --- removal semantics: editors cannot remove others; self-leave works;
    //     owner removal strips access instantly (404, no existence leak).
    const editorRemovesColleague = await api("DELETE", `/api/vaults/${vaultId}/members/${colleagueUserId}`, { jar: editor2Jar });
    step("an editor cannot remove OTHER members → 403", editorRemovesColleague.status === 403, `status ${editorRemovesColleague.status}`);
    const editor2Leaves = await api("DELETE", `/api/vaults/${vaultId}/members/${editor2UserId}`, { jar: editor2Jar });
    step("a non-owner may LEAVE (self-delete) → 204", editor2Leaves.status === 204, `status ${editor2Leaves.status}`);
    const leftEditorRead = await api("GET", `/api/vaults/${vaultId}`, { jar: editor2Jar });
    step("after leaving, the vault is 404 for the ex-editor", leftEditorRead.status === 404, `status ${leftEditorRead.status}`);
    const removeColleague = await api("DELETE", `/api/vaults/${vaultId}/members/${colleagueUserId}`);
    step("owner removes the viewer → 204", removeColleague.status === 204, `status ${removeColleague.status}`);
    const removedColleagueRead = await fetch(`${BASE}/api/vaults/${vaultId}/stats`, {
      headers: { origin: BASE, cookie: cookieHeader(colleagueJar) },
    });
    step("the removed member's access is gone → 404", removedColleagueRead.status === 404, `status ${removedColleagueRead.status}`);

    // --- revoke: a revoked pending invite's token is dead; double-revoke 404.
    const revokeeInvite = await inviteApi("POST", `/api/vaults/${vaultId}/invites`, {
      email: `revokee-${Date.now()}@example.com`,
      role: "viewer",
    });
    const revokeeToken = new URL(revokeeInvite.json.url, BASE).pathname.split("/invite/")[1];
    const revokeInv = await api("DELETE", `/api/vaults/${vaultId}/invites/${revokeeInvite.json.invite.id}`);
    step("owner revokes a pending invite → 204", revokeInv.status === 204, `status ${revokeInv.status}`);
    const revokedAccept = await inviteApi("POST", `/api/invites/${revokeeToken}/accept`, undefined, colleagueJar);
    step("a revoked token never accepts → 410", revokedAccept.status === 410, `status ${revokedAccept.status}`);
    const revokeAgain = await api("DELETE", `/api/vaults/${vaultId}/invites/${revokeeInvite.json.invite.id}`);
    step("revoking an already-revoked invite → 404", revokeAgain.status === 404, `status ${revokeAgain.status}`);

    // --- resend: ROTATES the token (old emailed link dies), re-emails, and
    //     returns a fresh one-time url.
    const resendeeEmail = `resendee-${Date.now()}@example.com`;
    const resendeeInvite = await inviteApi("POST", `/api/vaults/${vaultId}/invites`, {
      email: resendeeEmail,
      role: "viewer",
    });
    const resendeeToken1 = new URL(resendeeInvite.json.url, BASE).pathname.split("/invite/")[1];
    const resendMarker = devLog.length;
    const resend = await inviteApi(
      "POST",
      `/api/vaults/${vaultId}/invites/${resendeeInvite.json.invite.id}/resend`,
      undefined,
    );
    step("resend → 200 {invite, url}", resend.status === 200, `status ${resend.status}`);
    assertParse(inviteCreateResponseSchema, resend.json, "invite resend response parses ({invite, url})");
    const resendeeToken2 = new URL(resend.json.url, BASE).pathname.split("/invite/")[1];
    step("the resent token DIFFERS from the original", Boolean(resendeeToken2) && resendeeToken2 !== resendeeToken1);
    const resentEmailed = await captureInviteLink(resendeeEmail, resendMarker);
    step(
      "the resend was EMAILED — capture matches the new url",
      Boolean(resentEmailed) && resentEmailed.includes(resendeeToken2),
      (resentEmailed ?? "").slice(0, 60),
    );
    const supersededAccept = await inviteApi("POST", `/api/invites/${resendeeToken1}/accept`, undefined, colleagueJar);
    step("the SUPERSEDED (pre-resend) token is dead → 410", supersededAccept.status === 410, `status ${supersededAccept.status}`);
    const resentPage = await fetch(`${BASE}/invite/${resendeeToken2}`, { headers: { origin: BASE } });
    const resentPageHtml = await resentPage.text();
    step(
      "the RESENT token's invite page is live (renders the vault + invited email)",
      resentPage.status === 200 && resentPageHtml.includes(resendeeEmail),
      `status ${resentPage.status}`,
    );

    // --- expiry setup: mint one more invite now; §20's restart backdates its
    //     expires_at and asserts the token is dead.
    const expireeEmail = `expiree-${Date.now()}@example.com`;
    const expireeInvite = await inviteApi("POST", `/api/vaults/${vaultId}/invites`, {
      email: expireeEmail,
      role: "editor",
    });
    const expireeToken = new URL(expireeInvite.json.url, BASE).pathname.split("/invite/")[1];
    step("expiry setup: invite minted (backdated + asserted in §20)", Boolean(expireeToken));

    // ================================================================
    // 18. VAULT LIFECYCLE — rename, slug clash, concept delete, vault delete.
    // ================================================================

    const renamed = await api("PATCH", `/api/vaults/${other.json.id}`, { body: { name: "Other Renamed" } });
    step(
      "PATCH vault renames but keeps the slug",
      renamed.status === 200 && renamed.json?.name === "Other Renamed" && renamed.json?.slug === "other-vault",
      `${renamed.status} ${renamed.json?.name}/${renamed.json?.slug}`,
    );
    const slugClash = await api("PATCH", `/api/vaults/${other.json.id}`, { body: { slug: "e2e-vault" } });
    step("PATCH vault to a taken slug → 409", slugClash.status === 409, `status ${slugClash.status}`);

    const delConcept = await api("DELETE", `/api/vaults/${vaultId}/concepts/mcp-written-note`);
    step("DELETE concept → 204", delConcept.status === 204, `status ${delConcept.status}`);
    const delConceptGone = await api("GET", `/api/vaults/${vaultId}/concepts/mcp-written-note`);
    step("deleted concept GET → 404", delConceptGone.status === 404, `status ${delConceptGone.status}`);
    const delConceptAgain = await api("DELETE", `/api/vaults/${vaultId}/concepts/mcp-written-note`);
    step("DELETE of a missing concept → 404", delConceptAgain.status === 404, `status ${delConceptAgain.status}`);

    const delVault = await api("DELETE", `/api/vaults/${other.json.id}`);
    step("DELETE vault → 204", delVault.status === 204, `status ${delVault.status}`);
    const delVaultGone = await api("GET", `/api/vaults/${other.json.id}`);
    step("deleted vault GET → 404", delVaultGone.status === 404, `status ${delVaultGone.status}`);

    // ================================================================
    // 19. magic-link REQUEST rate limit (D1-backed): 5/hour/email. A fresh
    // address gets its 6th request throttled with a 429 that leaks nothing.
    // ================================================================
    const rlEmail = `ratelimit-${Date.now()}@example.com`;
    let rlOk = true;
    for (let i = 1; i <= 5; i++) {
      const r = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: rlEmail, callbackURL: "/dashboard" }),
      });
      if (r.status !== 200) rlOk = false;
    }
    step("magic-link requests 1-5 for one email succeed (200)", rlOk);
    const rlSixth = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: rlEmail, callbackURL: "/dashboard" }),
    });
    const rlBody = await rlSixth.json().catch(() => ({}));
    step(
      "6th magic-link request for the same email → 429 throttle (no existence leak)",
      rlSixth.status === 429 && !/exist|found/i.test(JSON.stringify(rlBody)),
      `status ${rlSixth.status}`,
    );
    // A MIXED-CASE variant of that SAME at-cap address is ALSO throttled — proof
    // the rate-limit bucket is keyed on the NORMALIZED email, so case-variants
    // share ONE bucket (a fresh bucket would reset the count and return 200).
    const rlVariant = rlEmail.toUpperCase();
    const rlVariantRes = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: rlVariant, callbackURL: "/dashboard" }),
    });
    step(
      "magic-link: a MIXED-CASE variant of the at-cap address is ALSO throttled → 429 (SHARED bucket)",
      rlVariantRes.status === 429,
      `variant ${rlVariant} → status ${rlVariantRes.status}`,
    );

    // ================================================================
    // 19b. EMAIL NORMALIZATION — mixed-case round-trip. Signing in with a
    // MIXED-CASE address must (a) store/return the email lowercase and (b)
    // resolve a subsequent LOWERCASE request to the SAME account (no fork).
    // This proves the system-wide lowercase invariant end to end; the
    // shared-rate-limit-bucket dimension is asserted just above (§19) and
    // exhaustively in the magic-link-guard unit test.
    // ================================================================
    const mixedLocal = `norm-${Date.now()}`;
    const mixedCase = `${mixedLocal}@Example.COM`;
    const lowerCase = `${mixedLocal}@example.com`;

    // (a) sign in with the MIXED-CASE address → follow the link → session.
    const mixedJar = new Map();
    const mixedLogin = await signInViaMagicLink(mixedCase, mixedJar);
    step(
      "normalization: sign-in with a MIXED-CASE email succeeds",
      mixedLogin.ok && mixedJar.size > 0,
      mixedLogin.ok ? "" : `failed at ${mixedLogin.reason} (status ${mixedLogin.status})`,
    );
    // The stored/returned email is LOWERCASE (Better Auth stores what our layer
    // normalized before handing it over).
    const mixedSession = await fetch(`${BASE}/api/auth/get-session`, {
      headers: { origin: BASE, cookie: cookieHeader(mixedJar) },
    });
    const mixedSessionJson = await mixedSession.json().catch(() => null);
    step(
      "normalization: the stored/returned email is lowercase (not the mixed-case input)",
      mixedSessionJson?.user?.email === lowerCase,
      `stored=${mixedSessionJson?.user?.email} (input ${mixedCase})`,
    );
    const mixedUserId = mixedSessionJson?.user?.id;

    // (b) No fork from case: exactly ONE user row exists for this address, and
    // it is the one the mixed-case sign-in created. We assert this at the DB
    // level rather than via a second magic-link round-trip: both case variants
    // normalize to ONE bucket, so a second send would be counted against the
    // shared per-email/per-IP rate limit (§19) and throttled (429) this late in
    // the run — throttling is correct product behaviour, not a fork. Querying
    // the `user` table directly is the fork-proof invariant: case-variant emails
    // resolve to a single row, and no lowercase variant spawned a second account.
    const userRows = run("npx", [
      "wrangler", "d1", "execute", "brainz", "--local", "--persist-to", STATE_DIR,
      "--json",
      "--command",
      `SELECT id FROM user WHERE email = '${lowerCase}' OR email = '${mixedCase}'`,
    ]);
    let normUsers = [];
    try {
      const parsed = JSON.parse(userRows.stdout);
      normUsers = parsed?.[0]?.results ?? [];
    } catch {
      /* fall through — normUsers stays empty, step fails loudly */
    }
    step(
      "normalization: a lowercase sign-in hits the SAME account (exactly one user row, its id === the mixed-case account — no fork)",
      Boolean(mixedUserId) &&
        normUsers.length === 1 &&
        normUsers[0]?.id === mixedUserId,
      `mixed=${mixedUserId} rows=${JSON.stringify(normUsers.map((r) => r.id))}`,
    );

    // ================================================================
    // 19b. OAUTH 2.1 (Wave OA) — the directory path. Discovery documents,
    // the lazy-auth 401 challenge, reviewer password sign-in (no email
    // verification), DCR, authorize → login → consent → code to a loopback
    // redirect on a port the client never registered, form-encoded token
    // exchange with NO Origin (server-to-server), MCP over the access token on
    // the picked vault, refresh rotation, reuse revoking the grant.
    // ================================================================
    {
    // Own block: these names would otherwise collide with earlier steps.
    console.log("\n-- OAuth 2.1 (Wave OA)");
    const prm = await api("GET", "/.well-known/oauth-protected-resource/mcp", { cookie: false });
    assertParse(oauthProtectedResourceMetadataSchema, prm.json, "protected-resource metadata (path-suffixed) parses");
    // wrangler dev rewrites request URLs to the custom-domain route host, so
    // the issuer here is that host, not BASE. Like a real client, read the
    // resource + issuer from the discovery documents instead of assuming them.
    const issuer = prm.json?.authorization_servers?.[0];
    const resource = prm.json?.resource;
    // …and its proxy maps the route host back to BASE in response HEADERS
    // (Location, WWW-Authenticate) but not in bodies: compare headers on BASE.
    const viaProxy = (s) => (typeof issuer === "string" ? s.replaceAll(issuer, BASE) : s);
    step(
      "PRM resource is <issuer>/mcp and names exactly one AS",
      typeof issuer === "string" && resource === `${issuer}/mcp` && prm.json?.authorization_servers?.length === 1,
      JSON.stringify(resource),
    );
    const prmRoot = await api("GET", "/.well-known/oauth-protected-resource", { cookie: false });
    step("PRM also served at the root well-known path", prmRoot.status === 200 && prmRoot.json?.resource === resource);
    const asMeta = await api("GET", "/.well-known/oauth-authorization-server", { cookie: false });
    assertParse(oauthAuthorizationServerMetadataSchema, asMeta.json, "authorization-server metadata parses");
    step(
      "AS metadata: issuer matches PRM; S256 only, DCR + CIMD, public clients",
      asMeta.json?.issuer === issuer &&
        JSON.stringify(asMeta.json?.code_challenge_methods_supported) === '["S256"]' &&
        Boolean(asMeta.json?.registration_endpoint) &&
        asMeta.json?.client_id_metadata_document_supported === true &&
        asMeta.json?.token_endpoint_auth_methods_supported?.includes("none"),
    );

    // Lazy auth: a gated tools/call with no token is an HTTP 401 challenge.
    const rpc = (body, headers = {}) =>
      fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(body),
      });
    const gated = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_concepts", arguments: { query: "x" } } });
    const challenge = gated.headers.get("www-authenticate") ?? "";
    step(
      "unauthenticated gated tools/call → 401 + resource_metadata challenge (not a 200 isError)",
      gated.status === 401 &&
        viaProxy(challenge).includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`) &&
        challenge.includes('scope="vault"'),
      `status ${gated.status} — ${challenge} — issuer ${issuer}`,
    );
    const publicCall = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "sign_in", arguments: { email: "nobody@example.com" } } });
    step("unauthenticated PUBLIC tool call still answers 200", publicCall.status === 200, `status ${publicCall.status}`);
    const badBearer = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { authorization: `Bearer bzat_${"x".repeat(40)}` });
    step(
      "a dead OAuth access token → 401 carrying the same challenge",
      badBearer.status === 401 && (badBearer.headers.get("www-authenticate") ?? "").includes("resource_metadata="),
      `status ${badBearer.status}`,
    );

    // Reviewer login: email + password, no inbox step (provisioned pre-boot).
    const reviewerJar = new Map();
    const reviewerSignIn = await api("POST", "/api/auth/sign-in/email", {
      body: { email: REVIEWER_EMAIL, password: REVIEWER_PASSWORD },
      jar: reviewerJar,
    });
    step(
      "reviewer signs in with email + password (no email verification)",
      reviewerSignIn.status === 200 && reviewerJar.size > 0,
      `status ${reviewerSignIn.status}`,
    );
    const reviewerWrong = await api("POST", "/api/auth/sign-in/email", {
      body: { email: REVIEWER_EMAIL, password: "definitely-not-the-password" },
      jar: new Map(),
    });
    step("wrong reviewer password → 401", reviewerWrong.status === 401, `status ${reviewerWrong.status}`);
    const reviewerVault = await api("POST", "/api/vaults", {
      body: { name: "Reviewer demo", slug: "reviewer-demo" },
      jar: reviewerJar,
    });
    step("reviewer creates a vault → 201", reviewerVault.status === 201, `status ${reviewerVault.status}`);
    const reviewerVaultId = reviewerVault.json?.id;
    await api("POST", `/api/vaults/${reviewerVaultId}/concepts`, {
      body: { id: "oauth-probe", title: "OAuth probe", body: "Written by the reviewer before connecting." },
      jar: reviewerJar,
    });

    // DCR as Claude Code would: a public client with loopback redirects.
    const reg = await api("POST", "/oauth/register", {
      cookie: false,
      body: {
        client_name: "E2E Claude Code",
        redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      },
    });
    step("DCR → 201 with a bzc_ client_id and no secret", reg.status === 201 && /^bzc_/.test(reg.json?.client_id ?? "") && !reg.json?.client_secret, `status ${reg.status}`);
    assertParse(oauthClientRegistrationResponseSchema, reg.json, "DCR response parses");
    const badReg = await api("POST", "/oauth/register", { cookie: false, body: { redirect_uris: ["http://evil.example/cb"] } });
    step("DCR rejects a non-loopback http redirect", badReg.status === 400 && badReg.json?.error === "invalid_redirect_uri", `status ${badReg.status}`);
    const clientId = reg.json?.client_id;

    const verifier = `e2e-verifier-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const challengeDigest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");
    const redirectUri = "http://localhost:43117/callback"; // port never registered
    const authorizeQs = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challengeDigest,
      code_challenge_method: "S256",
      state: "e2e-state",
      scope: "vault offline_access",
      resource,
    }).toString();
    const authorizePath = `/oauth/authorize?${authorizeQs}`;

    const anonAuthorize = await fetch(`${BASE}${authorizePath}`, { redirect: "manual" });
    const loginLocation = anonAuthorize.headers.get("location") ?? "";
    step(
      "authorize without a session → login, returning to the authorize URL",
      anonAuthorize.status === 303 && loginLocation.startsWith("/login?next=") &&
        // `next` carries the authorize URL encoded once more; decode both levels.
        viaProxy(decodeURIComponent(decodeURIComponent(loginLocation.slice("/login?next=".length)))) ===
          viaProxy(decodeURIComponent(authorizePath)),
      `status ${anonAuthorize.status} → ${decodeURIComponent(loginLocation)} vs ${authorizePath}`,
    );
    const evilAuthorize = await fetch(`${BASE}/oauth/authorize?${authorizeQs.replace(encodeURIComponent(redirectUri), encodeURIComponent("https://evil.example/cb"))}`, { redirect: "manual" });
    step("an unregistered redirect renders an error page, never redirects", evilAuthorize.status === 200, `status ${evilAuthorize.status}`);

    const consent = await fetch(`${BASE}${authorizePath}`, { redirect: "manual", headers: { cookie: cookieHeader(reviewerJar) } });
    const consentHtml = await consent.text();
    step(
      "consent page names the client, the redirect host and offers the reviewer's vault",
      consent.status === 200 && consentHtml.includes("E2E Claude Code") && consentHtml.includes("localhost:43117") &&
        consentHtml.includes("Reviewer demo") && consentHtml.includes(reviewerVaultId),
      `status ${consent.status}`,
    );

    const consentForm = new URLSearchParams(authorizeQs);
    consentForm.set("vault_id", reviewerVaultId);
    const crossSite = await fetch(`${BASE}/oauth/authorize?/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: cookieHeader(reviewerJar) },
      body: consentForm.toString(),
    });
    step("a cross-site POST to the consent action is refused (403)", crossSite.status === 403, `status ${crossSite.status}`);
    const approve = await fetch(`${BASE}/oauth/authorize?/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: BASE, cookie: cookieHeader(reviewerJar) },
      body: consentForm.toString(),
    });
    const approveLocation = new URL(approve.headers.get("location") ?? "http://x.invalid/");
    const code = approveLocation.searchParams.get("code");
    step(
      "approve → 303 to the loopback redirect with code, state and iss",
      approve.status === 303 && approveLocation.origin === "http://localhost:43117" &&
        approveLocation.pathname === "/callback" && Boolean(code) &&
        approveLocation.searchParams.get("state") === "e2e-state" && viaProxy(approveLocation.searchParams.get("iss") ?? "") === BASE,
      `status ${approve.status} → ${approveLocation.origin}${approveLocation.pathname} — ${approve.status === 303 ? "" : (await approve.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 700)}`,
    );

    // Token exchange: form-encoded, NO Origin header (server-to-server).
    const tokenCall = (form) =>
      fetch(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), headers: r.headers }));
    const exchanged = await tokenCall({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
    });
    step("token exchange (form-encoded, no Origin) → 200", exchanged.status === 200, `status ${exchanged.status} ${JSON.stringify(exchanged.json)}`);
    assertParse(oauthTokenResponseSchema, exchanged.json, "token response parses (bzat_ + rotating bzrt_)");
    step("token response is no-store", exchanged.headers.get("cache-control") === "no-store");
    const replay = await tokenCall({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId });
    step("replaying the code → invalid_grant", replay.status === 400 && replay.json?.error === "invalid_grant", `status ${replay.status}`);

    // The replay revoked that grant, so run the flow once more for a live one.
    const approve2 = await fetch(`${BASE}/oauth/authorize?/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin: BASE, cookie: cookieHeader(reviewerJar) },
      body: consentForm.toString(),
    });
    const code2 = new URL(approve2.headers.get("location") ?? "http://x.invalid/").searchParams.get("code");
    const live = await tokenCall({ grant_type: "authorization_code", code: code2, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId });
    step("second consent → fresh tokens", live.status === 200 && Boolean(live.json?.access_token), `status ${live.status}`);
    step(
      "the replayed code's grant is revoked (its access token 401s)",
      (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { authorization: `Bearer ${exchanged.json?.access_token}` })).status === 401,
    );

    const oauthTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${live.json?.access_token}` } },
    });
    const oauthMcp = new Client({ name: "brainz-e2e-oauth", version: "0.0.0" });
    await oauthMcp.connect(oauthTransport);
    const oauthTools = (await oauthMcp.listTools()).tools.map((t) => t.name);
    step(
      "MCP over the OAuth token: full vault toolset, no claim",
      MCP_TOOL_NAMES.every((n) => oauthTools.includes(n)) && !oauthTools.includes("claim"),
      oauthTools.length + " tools",
    );
    const probe = await oauthMcp.callTool({ name: "get_concept", arguments: { id: "oauth-probe" } });
    step(
      "OAuth token reads the vault picked at consent",
      !probe.isError && JSON.stringify(probe.content).includes("Written by the reviewer"),
      JSON.stringify(probe.content).slice(0, 80),
    );
    const otherVault = await oauthMcp.callTool({ name: "get_concept", arguments: { id: "lead-scoring" } });
    step("…and not another user's vault", otherVault.isError === true);
    await oauthMcp.close();

    // Refresh rotation + reuse detection.
    const rotated = await tokenCall({ grant_type: "refresh_token", refresh_token: live.json?.refresh_token, client_id: clientId });
    step(
      "refresh → new pair (refresh token rotated)",
      rotated.status === 200 && rotated.json?.refresh_token !== live.json?.refresh_token,
      `status ${rotated.status}`,
    );
    const reused = await tokenCall({ grant_type: "refresh_token", refresh_token: live.json?.refresh_token, client_id: clientId });
    step("reusing the rotated refresh token → invalid_grant", reused.status === 400 && reused.json?.error === "invalid_grant", `status ${reused.status}`);
    const afterTheft = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { authorization: `Bearer ${rotated.json?.access_token}` });
    step("…and the whole grant is revoked (newest access token 401s)", afterTheft.status === 401, `status ${afterTheft.status}`);
    const crossSiteRegister = await fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    step("cross-site form posts outside the token endpoints are still refused", crossSiteRegister.status === 403, `status ${crossSiteRegister.status}`);
    }

    // ================================================================
    // 20. EXPIRY ENFORCEMENT (Wave G) — signup → never claim → clock past
    // expiry → key 401s. Backdating expires_at needs exclusive D1 access, so
    // bounce wrangler dev around a `d1 execute`. Placeholder-email owners are
    // exactly the still-unclaimed provisional accounts; the CLAIMED account
    // (permanent, expires_at NULL) is untouched and must keep working.
    // ================================================================
    console.log("-- restarting wrangler dev with backdated unclaimed expiries…");
    await stopDev(dev);
    run("npx", [
      "wrangler", "d1", "execute", "brainz", "--local", "--persist-to", STATE_DIR,
      "--command", "UPDATE user SET expires_at = 1000 WHERE email LIKE '%@pending.brainz.invalid'",
    ]);
    // …and backdate the §17c expiry invite in the same exclusive-D1 window.
    run("npx", [
      "wrangler", "d1", "execute", "brainz", "--local", "--persist-to", STATE_DIR,
      "--command", "UPDATE vault_invite SET expires_at = 1000 WHERE accepted_at IS NULL",
    ]);
    dev = startDev();
    await waitForReady(dev);

    const expiredInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${expiringKey}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    };
    const expiredMcp = await fetch(`${BASE}/mcp`, expiredInit);
    const expiredMcpBody = await expiredMcp.text();
    step(
      "expired unclaimed key on /mcp → 401 with the workspace-expired message",
      expiredMcp.status === 401 && /workspace expired unclaimed/.test(expiredMcpBody),
      `status ${expiredMcp.status} — ${expiredMcpBody.slice(0, 90)}`,
    );
    const expiredRest = await fetch(`${BASE}/api/vaults/any-vault-id/stats`, {
      headers: { authorization: `Bearer ${expiringKey}` },
    });
    const expiredRestBody = await expiredRest.text();
    step(
      "expired unclaimed key on REST → 401 with the workspace-expired message",
      expiredRest.status === 401 && /workspace expired unclaimed/.test(expiredRestBody),
      `status ${expiredRest.status} — ${expiredRestBody.slice(0, 90)}`,
    );
    // The claimed workspace's key still works — approval made it permanent.
    const claimedInit = {
      ...expiredInit,
      headers: { ...expiredInit.headers, authorization: `Bearer ${claimedKey}` },
    };
    const claimedStill = await fetch(`${BASE}/mcp`, claimedInit);
    step(
      "claimed workspace's key still works past the window (account permanent)",
      claimedStill.status === 200,
      `status ${claimedStill.status}`,
    );

    // Wave M expiry: the §17c invite is now past its (backdated) expires_at —
    // the token neither accepts nor renders, and it drops off the pending list.
    const expiredInviteAccept = await fetch(`${BASE}/api/invites/${expireeToken}/accept`, {
      method: "POST",
      headers: { origin: BASE, cookie: cookieHeader() },
    });
    step(
      "an EXPIRED invite token never accepts → 410",
      expiredInviteAccept.status === 410,
      `status ${expiredInviteAccept.status}`,
    );
    const expiredInvitePage = await fetch(`${BASE}/invite/${expireeToken}`, { headers: { origin: BASE } });
    const expiredInviteHtml = await expiredInvitePage.text();
    step(
      "the expired token's invite page no longer offers the vault",
      expiredInvitePage.status === 200 && !expiredInviteHtml.includes(expireeEmail),
      `status ${expiredInvitePage.status}`,
    );
    const expiredPending = await api("GET", `/api/vaults/${vaultId}/invites`);
    step(
      "expired invites drop out of the pending list",
      expiredPending.status === 200 &&
        !(expiredPending.json?.invites ?? []).some((i) => i.email === expireeEmail),
      JSON.stringify(expiredPending.json?.invites?.map((i) => i.email)),
    );
  } catch (err) {
    failed++;
    process.exitCode = 1;
    console.error("\nE2E aborted:", err);
    console.error("\n-- last wrangler dev output --\n", devLog.slice(-3000));
  } finally {
    await stopDev(dev);
  }

  console.log(`\n== E2E summary: ${passed} passed, ${failed} failed ==`);
  for (const n of notes) console.log(`   note: ${n}`);
}

main();
