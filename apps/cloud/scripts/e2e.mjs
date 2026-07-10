#!/usr/bin/env node
/**
 * Brainz Cloud E2E journey against `wrangler dev` (the real workerd runtime:
 * SvelteKit worker + D1 + VaultDO, fresh state per run).
 *
 * Flow: signup → cookie → create vault → upsert 3 concepts (wiki-links +
 * typed relations) → search → related → context (budget respected) → graph
 * (pending node) → API key (plaintext once) → MCP over HTTP with the bearer
 * key (initialize, tools/list, get_context, upsert_concept) → verify via
 * REST → revoked key gets 401 → PUBLIC signup over unauthenticated MCP
 * (exactly one tool, provision account/vault/key, claim-link handoff,
 * duplicate-email + per-IP rate limit, invalid bearer still 401).
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
import { existsSync, rmSync } from "node:fs";
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
  relatedResponseSchema,
  searchResponseSchema,
  signupOutputSchema,
  statsResponseSchema,
  upsertConceptOutputSchema,
  vaultSchema,
} from "@brainz/contracts";

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

function storeCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function api(method, pathName, { body, cookie = true, bearer } = {}) {
  // Node's fetch (undici) would otherwise send `Origin: null`, which Better
  // Auth rejects; send a real browser-like Origin instead.
  const headers = { origin: BASE };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie && jar.size > 0) headers.cookie = cookieHeader();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${BASE}${pathName}`, {
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

  try {
    await waitForReady(dev);
    console.log("-- wrangler dev ready\n");

    // 1. signup (email/password) → session cookie
    const email = `e2e-${Date.now()}@example.com`;
    const signup = await api("POST", "/api/auth/sign-up/email", {
      body: { name: "E2E User", email, password: "correct-horse-battery" },
    });
    step("signup returns 200", signup.status === 200, `status ${signup.status}`);
    step("signup sets a session cookie", jar.size > 0, [...jar.keys()].join(", "));

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
        body: "Scores leads by fit and intent. Reads [[user-model]] data; see also [[missing-concept]].",
        relations: { depends_on: ["auth-system"] },
      },
    ];
    for (const c of concepts) {
      const res = await api("POST", `/api/vaults/${vaultId}/concepts`, { body: c });
      step(`upsert concept ${c.id} → 201`, res.status === 201, `status ${res.status}`);
    }

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
    step("stats counts 3 concepts / 4 edges", stats.json?.concepts === 3 && stats.json?.edges === 4,
      `concepts=${stats.json?.concepts} edges=${stats.json?.edges}`);
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
      "MCP tools/list returns the 8 contract tools",
      toolNames.length === 8 && JSON.stringify(toolNames) === JSON.stringify([...MCP_TOOL_NAMES].sort()),
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

    const upsert = await mcp.callTool({
      name: "upsert_concept",
      arguments: {
        title: "MCP written note",
        body: "Captured via remote MCP during E2E. Links to [[lead-scoring]].",
        tags: ["e2e"],
      },
    });
    const upsertPayload = JSON.parse(upsert.content.find((c) => c.type === "text").text);
    step(
      "MCP upsert_concept output parses with contract outputSchema",
      upsertConceptOutputSchema.strict().safeParse(upsertPayload).success,
      JSON.stringify(upsertPayload),
    );
    const searchTool = await mcp.callTool({ name: "search_concepts", arguments: { query: "auth" } });
    const searchPayload = JSON.parse(searchTool.content.find((c) => c.type === "text").text);
    step(
      "MCP search_concepts output parses with contract outputSchema",
      getMcpTool("search_concepts").outputSchema.safeParse(searchPayload).success,
    );
    await mcp.close();

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
      "unauthenticated tools/list is exactly [signup] — none of the 8 vault tools",
      JSON.stringify(pubNames) === JSON.stringify(["signup"]) &&
        !pubNames.some((n) => MCP_TOOL_NAMES.includes(n)),
      pubNames.join(", "),
    );

    const claimEmail = `agent-${Date.now()}@example.com`;
    const signupRes = await pub.callTool({
      name: "signup",
      arguments: { email: claimEmail, vaultName: "Agent Vault" },
    });
    step("public signup tool call succeeds", signupRes.isError !== true);
    const signupPayload = JSON.parse(signupRes.content.find((c) => c.type === "text").text);
    assertParse(signupOutputSchema, signupPayload, "signup output parses with contract schema");
    // wrangler dev rewrites the request host to the configured custom domain,
    // so assert the claim PATH (which we then exercise against BASE) + slug.
    const claimPath = new URL(signupPayload.claimUrl).pathname;
    step(
      "claimUrl carries a /claim/<64-hex-token> path and slug derives from vaultName",
      /^\/claim\/[0-9a-f]{64}$/.test(claimPath) && signupPayload.vaultSlug === "agent-vault",
      `${signupPayload.vaultSlug} ${claimPath.slice(0, 20)}…`,
    );

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

    // pre-claim: NO credential account row exists → password sign-in fails cleanly
    const preClaim = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: claimEmail, password: "some-guess-12345" }),
    });
    step("pre-claim password sign-in fails cleanly (401)", preClaim.status === 401, `status ${preClaim.status}`);

    // 13. claim flow over HTTP (own cookie jar — the human's browser)
    const claimPage = await fetch(`${BASE}${claimPath}`);
    const claimHtml = await claimPage.text();
    step(
      "GET claim page → 200 and shows the account email",
      claimPage.status === 200 && claimHtml.includes(claimEmail),
      `status ${claimPage.status}`,
    );

    const claimJar = new Map();
    const claimPassword = "chosen-by-human-42";
    // accept: text/html = a real browser form post → SvelteKit answers with a
    // true 303 redirect (Accept: */* would get the JSON action envelope).
    const setPw = await fetch(`${BASE}${claimPath}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: BASE,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ password: claimPassword }).toString(),
    });
    for (const raw of setPw.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) claimJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    step(
      "POST set-password → 303 redirect to /dashboard",
      setPw.status === 303 && setPw.headers.get("location") === "/dashboard",
      `status ${setPw.status} → ${setPw.headers.get("location")}`,
    );
    step("claiming sets a session cookie", claimJar.size > 0, [...claimJar.keys()].join(", "));

    const claimCookie = [...claimJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const claimVaults = await fetch(`${BASE}/api/vaults`, { headers: { cookie: claimCookie } });
    const claimVaultsJson = await claimVaults.json().catch(() => null);
    step(
      "claimed session sees the agent-created vault via GET /api/vaults",
      claimVaults.status === 200 &&
        claimVaultsJson?.vaults?.some((v) => v.slug === signupPayload.vaultSlug),
      JSON.stringify(claimVaultsJson?.vaults?.map((v) => v.slug)),
    );

    const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: claimCookie } });
    const dashHtml = await dash.text();
    step(
      "dashboard loads for the claimed session and lists the vault",
      dash.status === 200 && dashHtml.includes("Agent Vault"),
      `status ${dash.status}`,
    );

    const postClaimSignIn = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: claimEmail, password: claimPassword }),
    });
    step(
      "post-claim email+password sign-in succeeds",
      postClaimSignIn.status === 200,
      `status ${postClaimSignIn.status}`,
    );

    const reusedPage = await fetch(`${BASE}${claimPath}`);
    const reusedHtml = await reusedPage.text();
    step(
      "claim link is single-use (revisit reports it was already used)",
      reusedPage.status === 200 && reusedHtml.includes("already been used"),
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
