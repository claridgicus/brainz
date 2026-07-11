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
 * tools/list = 9 tools, get_context, upsert_concept, onboarding nudge,
 * onboard status/start/complete + nudge disappearing) → verify via REST →
 * revoked key gets 401 → PUBLIC signup over unauthenticated MCP (exactly one
 * tool, provision account/vault/key, magic loginUrl signs the human in,
 * duplicate-email + per-IP rate limit, invalid bearer still 401) → assert NO
 * password endpoints work → magic-link request rate-limit trips.
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
  apiKeyListResponseSchema,
  contextResponseSchema,
  getContextOutputSchema,
  getMcpTool,
  graphResponseSchema,
  MCP_TOOL_NAMES,
  onboardCompleteOutputSchema,
  onboardStatusOutputSchema,
  relatedResponseSchema,
  searchResponseSchema,
  signupOutputSchema,
  statsResponseSchema,
  upsertConceptOutputSchema,
  vaultSchema,
} from "@brainz/contracts";
import { ONBOARDING_NUDGE, ONBOARDING_SUMMARY_ID } from "@brainz/engine";

const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.E2E_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = path.join(appDir, ".wrangler", "e2e-state");

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

  console.log(`-- starting wrangler dev on :${PORT}…`);
  const dev = spawn(
    "npx",
    // --local: remote bindings (Workers AI) disabled so no Cloudflare login is
    // needed; the vault degrades to keyword-only search, which we assert.
    ["wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", STATE_DIR, "--show-interactive-dev-session=false"],
    { cwd: appDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let devLog = "";
  dev.stdout.on("data", (d) => (devLog += d));
  dev.stderr.on("data", (d) => (devLog += d));

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

  // Establish a fresh authenticated session for `email` the passwordless way —
  // request a magic link, capture it from the mailer, follow it — and store the
  // resulting session cookie into `targetJar`. This is the only way to create a
  // second user ("user B") now that email+password sign-up is gone; it reuses
  // the exact request → capture → verify mechanism the primary flow above uses.
  async function signInViaMagicLink(email, targetJar) {
    const { res, marker } = await requestMagicLink(email);
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

    // No password endpoints exist any more.
    const pwSignIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: "anything-at-all-123" }),
    });
    step(
      "email+password sign-in endpoint is gone (4xx, never 200)",
      pwSignIn.status >= 400 && pwSignIn.status !== 200,
      `status ${pwSignIn.status}`,
    );
    const pwSignUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ name: "X", email: `x-${Date.now()}@example.com`, password: "anything-123" }),
    });
    step(
      "email+password sign-up endpoint is gone (4xx, never 200)",
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
      "MCP tools/list returns the contract tools (incl. onboard + task tools)",
      toolNames.length === MCP_TOOL_NAMES.length &&
        JSON.stringify(toolNames) === JSON.stringify([...MCP_TOOL_NAMES].sort()) &&
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
        startBlocks[0].includes("20–60 concepts") &&
        startBlocks[0].includes("realized_by") &&
        startBlocks[0].includes("governs"),
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
      "unauthenticated tools/list is exactly [signup] — none of the 9 vault tools",
      JSON.stringify(pubNames) === JSON.stringify(["signup"]) &&
        !pubNames.some((n) => MCP_TOOL_NAMES.includes(n)),
      pubNames.join(", "),
    );

    const claimEmail = `agent-${Date.now()}@example.com`;
    const signupRes = await pub.callTool({
      name: "signup",
      arguments: { email: claimEmail, vaultName: "Agent Vault" },
    });
    step(
      "public signup tool call succeeds",
      signupRes.isError !== true,
      signupRes.isError ? (signupRes.content.find((c) => c.type === "text")?.text ?? "").slice(0, 160) : "",
    );
    const signupPayload = JSON.parse(signupRes.content.find((c) => c.type === "text").text);
    assertParse(signupOutputSchema, signupPayload, "signup output parses with contract schema");
    // The loginUrl is a real Better Auth magic link (single-use). wrangler dev
    // rewrites the host to the custom domain, so assert the PATH + slug.
    const loginUrl = new URL(signupPayload.loginUrl);
    step(
      "loginUrl is a magic-link/verify link and slug derives from vaultName",
      /\/api\/auth\/magic-link\/verify$/.test(loginUrl.pathname) &&
        loginUrl.searchParams.get("token") &&
        signupPayload.vaultSlug === "agent-vault",
      `${signupPayload.vaultSlug} ${loginUrl.pathname}`,
    );
    step("signup output has no legacy claimUrl field", !("claimUrl" in signupPayload));

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
    await agentMcp.close();

    // 13. the human follows the magic loginUrl → signed straight into dashboard
    // (own cookie jar — the human's browser). Unknown-until-now credential path:
    // there is no password to set; the link IS the sign-in.
    const humanJar = new Map();
    const followLogin = await fetch(`${BASE}${loginUrl.pathname}${loginUrl.search}`, {
      method: "GET",
      redirect: "manual",
      headers: { origin: BASE },
    });
    for (const raw of followLogin.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) humanJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    step(
      "following signup loginUrl signs the human in (redirect + session cookie)",
      (followLogin.status === 302 || followLogin.status === 303) && humanJar.size > 0,
      `status ${followLogin.status} → ${followLogin.headers.get("location")}`,
    );

    const humanCookie = [...humanJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const humanVaults = await fetch(`${BASE}/api/vaults`, { headers: { cookie: humanCookie } });
    const humanVaultsJson = await humanVaults.json().catch(() => null);
    step(
      "signed-in session sees the agent-created vault via GET /api/vaults",
      humanVaults.status === 200 &&
        humanVaultsJson?.vaults?.some((v) => v.slug === signupPayload.vaultSlug),
      JSON.stringify(humanVaultsJson?.vaults?.map((v) => v.slug)),
    );

    const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: humanCookie } });
    const dashHtml = await dash.text();
    step(
      "dashboard loads for the signed-in session and lists the vault",
      dash.status === 200 && dashHtml.includes("Agent Vault"),
      `status ${dash.status}`,
    );

    // The magic link is single-use: following it again must NOT mint a session.
    const reuseJar = new Map();
    const reused = await fetch(`${BASE}${loginUrl.pathname}${loginUrl.search}`, {
      method: "GET",
      redirect: "manual",
      headers: { origin: BASE },
    });
    for (const raw of reused.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) reuseJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    step(
      "magic link is single-use (second follow mints no session cookie)",
      reuseJar.size === 0,
      `cookies=${reuseJar.size}, → ${reused.headers.get("location")}`,
    );

    // 14. duplicate email + per-IP rate limit (5/hour), still over the public server
    const dup = await pub.callTool({ name: "signup", arguments: { email: claimEmail } });
    const dupText = dup.content.find((c) => c.type === "text")?.text ?? "";
    step(
      "second signup with the same email → isError with sign-in guidance",
      dup.isError === true && dupText.includes("already exists") && dupText.includes("/login"),
      dupText.slice(0, 90),
    );

    let more = true;
    for (let i = 2; i <= 5; i++) {
      const r = await pub.callTool({
        name: "signup",
        arguments: { email: `agent-${Date.now()}-${i}@example.com` },
      });
      if (r.isError) more = false;
    }
    step("signups 2-5 from the same IP within the hour still succeed", more);
    const sixth = await pub.callTool({
      name: "signup",
      arguments: { email: `agent-${Date.now()}-6@example.com` },
    });
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
    // 17. VALIDATION FAILURES — every parse boundary answers 400 with {error}.
    // ================================================================

    const badBodies = [
      ["POST", "/api/vaults", {}, "vault create without name"],
      ["POST", "/api/vaults", { name: "" }, "vault create with empty name"],
      ["POST", `/api/vaults/${vaultId}/concepts`, { title: "No body here" }, "concept without body"],
      ["POST", `/api/vaults/${vaultId}/concepts`, { title: "x", body: "y", type: "banana" }, "concept with unknown type"],
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
  } catch (err) {
    failed++;
    process.exitCode = 1;
    console.error("\nE2E aborted:", err);
    console.error("\n-- last wrangler dev output --\n", devLog.slice(-3000));
  } finally {
    dev.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (dev.exitCode === null) dev.kill("SIGKILL");
  }

  console.log(`\n== E2E summary: ${passed} passed, ${failed} failed ==`);
  for (const n of notes) console.log(`   note: ${n}`);
}

main();
