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
 * vault" above Allow, a duplicate approve getting the same code) → the
 * vault's "Dreaming for this vault" card (SSR, REST settings + bounds, and a
 * browser save of the mode select) → epics (create_task's epic, the
 * epic-grouped board's lanes, columns and roll-up, a re-parent, an epic
 * burndown scope; in a browser the card's epic picker and a remembered
 * collapsed lane) → the features tree (SSR, the board's ?scope= filter, and
 * in a browser collapse/expand, the node panel and Show on board). When
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

async function burndownJourney(vaultId, task) {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
  const it = await api("POST", `/api/vaults/${vaultId}/concepts`, {
    body: { id: "sprint-1", title: "Sprint 1", type: "iteration", startDate: today, endDate: end, body: "First sprint." },
  });
  step(
    "create an iteration with dates → 201",
    it.status === 201 && it.json?.type === "iteration" && it.json?.startDate === today,
    `status ${it.status} ${it.json?.type} ${it.json?.startDate}`,
  );
  const current = await api("GET", `/api/vaults/${vaultId}/concepts/${task.id}`);
  const put = await api("PUT", `/api/vaults/${vaultId}/concepts/${task.id}`, {
    body: { title: current.json.title, body: current.json.body, estimate: 3, relations: { part_of: ["auth-system", "sprint-1"] } },
  });
  step("assign the task to the iteration (PUT part_of) → 200", put.status === 200 && put.json?.estimate === 3, `status ${put.status}`);
  // The board's picker: a second iteration, swapped server-side. The task's
  // other part_of (auth-system) must survive even though the request names
  // only the iteration.
  await api("POST", `/api/vaults/${vaultId}/concepts`, {
    body: { id: "sprint-0", title: "Sprint 0", type: "iteration", startDate: today, endDate: end, body: "" },
  });
  const swap = await api("POST", `/api/vaults/${vaultId}/concepts/${task.id}/membership`, {
    body: { type: "iteration", target: "sprint-0" },
  });
  const back = await api("POST", `/api/vaults/${vaultId}/concepts/${task.id}/membership`, {
    body: { type: "iteration", target: "sprint-1" },
  });
  const graphAfter = await api("GET", `/api/vaults/${vaultId}/graph`);
  const partOf = (graphAfter.json?.edges ?? [])
    .filter((e) => e.from === task.id && e.relation === "part_of")
    .map((e) => e.to)
    .sort();
  step(
    "membership swap keeps the task's other links (server-side, atomic)",
    swap.status === 200 && back.status === 200 && JSON.stringify(partOf) === JSON.stringify(["auth-system", "sprint-1"]),
    `${swap.status}/${back.status} ${JSON.stringify(partOf)}`,
  );
  const take = await api("PATCH", `/api/vaults/${vaultId}/tasks/${task.id}`, { body: { action: "take", takenBy: "e2e-agent" } });
  const done = await api("PATCH", `/api/vaults/${vaultId}/tasks/${task.id}`, { body: { action: "complete", outcome: "Done in e2e." } });
  step("take + complete the task → 200", take.status === 200 && done.status === 200, `${take.status}/${done.status}`);

  const bd = await api("GET", `/api/vaults/${vaultId}/burndown?scope=sprint-1&unit=points`);
  step(
    "GET burndown for the iteration → 200 with the task done",
    bd.status === 200 && bd.json?.totals?.scope === 3 && bd.json?.totals?.done === 3 && bd.json?.scope?.type === "iteration",
    `status ${bd.status} ${JSON.stringify(bd.json?.totals)}`,
  );
  step(
    "burndown carries the ideal line and the agent",
    (bd.json?.series ?? []).some((p) => p.ideal !== null) && (bd.json?.agents ?? []).some((a) => a.agent === "e2e-agent"),
  );
  const unknown = await api("GET", `/api/vaults/${vaultId}/burndown?scope=no-such-thing`);
  step("burndown on an unknown scope → 404", unknown.status === 404, `status ${unknown.status}`);

  // Parallel iterations: Sprint 0 and Sprint 1 both start today. Under one
  // milestone their velocity rows share a start date, which once crashed the
  // panel with a duplicate {#each} key.
  await api("POST", `/api/vaults/${vaultId}/concepts`, {
    body: { id: "release-1", title: "Release 1", type: "milestone", endDate: end, body: "" },
  });
  const parents = await Promise.all(
    ["sprint-0", "sprint-1"].map((id) =>
      api("POST", `/api/vaults/${vaultId}/concepts/${id}/membership`, { body: { type: "milestone", target: "release-1" } }),
    ),
  );
  const rel = await api("GET", `/api/vaults/${vaultId}/burndown?scope=release-1`);
  const periods = rel.json?.velocity?.periods ?? [];
  step(
    "parallel iterations under a milestone: one velocity row each, same start day",
    parents.every((r) => r.status === 200) &&
      rel.status === 200 &&
      rel.json?.velocity?.by === "iteration" &&
      periods.length === 2 &&
      periods[0].from === periods[1].from,
    `status ${rel.status} ${JSON.stringify(periods.map((p) => [p.id, p.from]))}`,
  );

  const panel = await page("/v/ui-vault/burndown?scope=sprint-1");
  step("/v/ui-vault/burndown → 200", panel.status === 200, `status ${panel.status}`);
  step(
    "panel SSR: scope picker, summary tiles and chart",
    panel.html.includes("Burndown") &&
      panel.html.includes("Sprint 1") &&
      panel.html.includes("Remaining") &&
      panel.html.includes("Projected") &&
      panel.html.includes('role="img"'),
  );
  step("panel SSR: agents table lists the agent", panel.html.includes("e2e-agent"));
  step(
    "panel SSR: the unit chips are real links (work before hydration)",
    /<a[^>]*data-unit="points"[^>]*href="\?scope=sprint-1&amp;unit=points"|<a[^>]*href="\?scope=sprint-1&amp;unit=points"[^>]*data-unit="points"/.test(panel.html),
  );
  step("panel SSR: iterations & milestones list + editor", panel.html.includes("Iterations &amp; milestones") && panel.html.includes("New iteration"));
  const boardIt = await page("/v/ui-vault/board");
  step("board SSR: the iteration picker", boardIt.html.includes("No iteration") && boardIt.html.includes("Sprint 1"));
  const ws = await page("/v/ui-vault");
  step("workspace links to the burndown", ws.html.includes("/v/ui-vault/burndown"));

  if (!hasAgentBrowser()) {
    console.log("  [SKIP] browser burndown panel (agent-browser not on PATH, or E2E_UI_BROWSER=0)");
    return;
  }
  try {
    const base = new URL(BASE);
    for (const [name, value] of jar) agentBrowser(["cookies", "set", name, value, "--url", `${base.origin}/`]);
    // Everything below waits on a condition (hydration, the outcome) with a
    // generous deadline, never a fixed sleep: on a loaded box hydration and
    // client navigation can take far longer than any sleep we'd pick.
    agentBrowser(["open", `${BASE}/v/ui-vault/burndown?scope=sprint-1`]);
    const hydrated = await browserUntil(`document.querySelector('.bd-page')?.dataset.hydrated === 'true'`);
    step("browser: the burndown panel hydrates", hydrated !== null);
    const chart = await browserUntil(`!!document.querySelector('.bd-root svg path.remaining')`);
    step("browser: the chart renders", chart !== null);
    if (process.env.E2E_UI_SCREENSHOT) {
      agentBrowser(["screenshot", "--full", process.env.E2E_UI_SCREENSHOT.replace(/(\.png)?$/, "-burndown-load.png")]);
    }

    // Hover: a real pointer moving across the plot, retried until the
    // tooltip shows (the handler only exists once hydrated).
    let tip = "";
    const tipDeadline = Date.now() + BROWSER_DEADLINE_MS;
    while (Date.now() < tipDeadline && !tip.includes("Remaining")) {
      agentBrowser(["eval", `document.querySelector('.bd-root svg')?.scrollIntoView({ block: 'center' })`]);
      const [bx, by] = agentBrowser([
        "eval",
        `(() => { const r = document.querySelector('.bd-root svg').getBoundingClientRect(); return Math.round(r.left + r.width * 0.3) + ',' + Math.round(r.top + r.height * 0.5); })()`,
      ])
        .replace(/"/g, "")
        .split(",")
        .map(Number);
      agentBrowser(["mouse", "move", String(bx), String(by)]);
      agentBrowser(["mouse", "move", String(bx + 20), String(by)]);
      tip = (await browserUntil(`document.querySelector('.bd-root .tip')?.textContent ?? ''`, { timeoutMs: 2000 })) ?? "";
    }
    step("browser: hovering the chart shows the crosshair tooltip", tip.includes("Remaining") && tip.includes("Scope"), tip.slice(0, 80));
    if (process.env.E2E_UI_SCREENSHOT) {
      agentBrowser(["screenshot", "--full", process.env.E2E_UI_SCREENSHOT.replace(/(\.png)?$/, "-burndown.png")]);
    }

    // The unit chips are real links (they work before hydration too).
    agentBrowser(["click", 'a.chip[data-unit="points"]']);
    const unitUrl = await browserUntil(
      `location.search.includes('unit=points') && document.querySelector('a.chip[data-unit="points"]')?.getAttribute('aria-current') === 'true' ? location.search : ''`,
    );
    step("browser: the Points chip switches the unit in the URL", Boolean(unitUrl?.includes("unit=points")), unitUrl ?? "(timed out)");

    // The editor needs JS: its button is disabled until hydrated, so wait for
    // it to be enabled, then for the form, then for the saved concept.
    const enabled = await browserUntil(
      `(() => { const b = document.querySelector('[data-testid="new-iteration"]'); return !!b && !b.disabled; })()`,
    );
    step("browser: New iteration is enabled once hydrated", enabled !== null);
    agentBrowser(["click", '[data-testid="new-iteration"]']);
    const formOpen = await browserUntil(`!!document.querySelector('#bd-title')`);
    step("browser: the iteration form opens", formOpen !== null);
    // Set values the way a user's typing lands for Svelte's bind:value (native
    // date inputs don't take typed text from agent-browser).
    const setValue = (sel, value) =>
      agentBrowser([
        "eval",
        `(() => { const el = document.querySelector('${sel}'); el.value = '${value}'; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`,
      ]);
    setValue("#bd-title", "Sprint 2");
    setValue("#bd-start", new Date().toISOString().slice(0, 10));
    setValue("#bd-end", new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10));
    agentBrowser(["click", ".draft button[type=submit]"]);
    let created = { status: 0, json: null };
    const savedDeadline = Date.now() + BROWSER_DEADLINE_MS;
    while (Date.now() < savedDeadline) {
      created = await api("GET", `/api/vaults/${vaultId}/concepts/sprint-2`);
      if (created.status === 200) break;
      await sleep(500);
    }
    if (process.env.E2E_UI_SCREENSHOT) {
      agentBrowser(["screenshot", "--full", process.env.E2E_UI_SCREENSHOT.replace(/(\.png)?$/, "-burndown-saved.png")]);
    }
    step(
      "browser: creating an iteration from the panel saves it with dates",
      created.status === 200 && created.json?.type === "iteration" && Boolean(created.json?.endDate),
      `status ${created.status} ${created.json?.startDate} → ${created.json?.endDate}`,
    );

    // The milestone with two same-day iterations renders both velocity rows
    // after hydration (a duplicate key would throw and leave the page broken).
    agentBrowser(["open", `${BASE}/v/ui-vault/burndown?scope=release-1`]);
    const relHydrated = await browserUntil(`document.querySelector('.bd-page')?.dataset.hydrated === 'true'`);
    const rows = await browserUntil(
      `(() => { const s = [...document.querySelectorAll('section.card')].find((c) => c.querySelector('h2')?.textContent?.startsWith('Velocity')); const labels = [...(s?.querySelectorAll('.bars li .bar-label') ?? [])].map((l) => l.textContent.trim()); return labels.includes('Sprint 0') && labels.includes('Sprint 1') ? labels.join('|') : ''; })()`,
    );
    step("browser: parallel iterations each get a velocity row", relHydrated !== null && rows !== null, rows ?? "(timed out)");
  } finally {
    spawnSync("agent-browser", ["--session", "brainz-e2e-ui", "close"]);
  }
}

async function epicJourney(vaultId) {
  const mk = (body) => api("POST", `/api/vaults/${vaultId}/concepts`, { body });
  const e1 = await mk({ id: "checkout-epic", title: "Checkout v2", type: "epic", body: "An epic." });
  await mk({ id: "platform-epic", title: "Platform", type: "epic", body: "Another epic." });
  await mk({ id: "pay-button", title: "Pay button", type: "feature", body: "", relations: { part_of: ["checkout-epic"] } });
  step("create an epic → 201 typed epic", e1.status === 201 && e1.json?.type === "epic", `status ${e1.status} ${e1.json?.type}`);
  const direct = await api("POST", `/api/vaults/${vaultId}/tasks`, {
    body: { title: "Epic direct task", body: "x", domain: "auth-system", epic: "checkout-epic" },
  });
  const inherited = await api("POST", `/api/vaults/${vaultId}/tasks`, {
    body: { title: "Epic feature task", body: "x", realizes: ["pay-button"] },
  });
  const edgesOf = async (id) =>
    ((await api("GET", `/api/vaults/${vaultId}/graph`)).json?.edges ?? [])
      .filter((e) => e.from === id && e.relation === "part_of")
      .map((e) => e.to)
      .sort();
  const directEdges = await edgesOf(direct.json?.id);
  step(
    "POST /tasks with an epic links it part_of the domain and the epic",
    direct.status === 201 && inherited.status === 201 && JSON.stringify(directEdges) === JSON.stringify(["auth-system", "checkout-epic"]),
    `${direct.status}/${inherited.status} ${JSON.stringify(directEdges)}`,
  );
  const types = await api("GET", `/api/vaults/${vaultId}/types`);
  step(
    "the type registry carries the epic built-in",
    (types.json?.types ?? []).some((t) => t.key === "epic" && t.builtin),
    `status ${types.status}`,
  );

  const board = await page("/v/ui-vault/board?group=epic");
  const h = board.html;
  step("/v/ui-vault/board?group=epic → 200", board.status === 200, `status ${board.status}`);
  step(
    "epic board SSR: one lane per epic plus No epic",
    h.includes('aria-label="Epic: Checkout v2"') && h.includes('aria-label="Epic: Platform"') && h.includes('aria-label="Epic: No epic"'),
  );
  step(
    "epic board SSR: each lane keeps its open/taken/done columns",
    h.includes('aria-label="Checkout v2 · open"') && h.includes('aria-label="Checkout v2 · taken"') && h.includes('aria-label="Checkout v2 · done"'),
  );
  // Both the direct task and the one under the epic's feature count (closure).
  step("epic board SSR: the lane roll-up counts inherited tasks (0/2 done)", /0\/2<\/strong>/.test(h));
  step("epic board SSR: cards carry the epic picker", h.includes("No epic</option>"));

  // Re-parent the direct task (what a drag to the Platform lane sends).
  const move = await api("POST", `/api/vaults/${vaultId}/concepts/${direct.json?.id}/membership`, {
    body: { type: "epic", target: "platform-epic" },
  });
  const moved = await edgesOf(direct.json?.id);
  step(
    "re-parent to another epic keeps the domain link (server-side, atomic)",
    move.status === 200 && JSON.stringify(moved) === JSON.stringify(["auth-system", "platform-epic"]),
    `${move.status} ${JSON.stringify(moved)}`,
  );
  const wrong = await api("POST", `/api/vaults/${vaultId}/concepts/${direct.json?.id}/membership`, {
    body: { type: "epic", target: "pay-button" },
  });
  step("re-parent onto a non-epic → 400", wrong.status === 400, `status ${wrong.status}`);
  const bd = await api("GET", `/api/vaults/${vaultId}/burndown?scope=checkout-epic`);
  step(
    "an epic is a burndown scope (closure counts the feature's task)",
    bd.status === 200 && bd.json?.scope?.type === "epic" && bd.json?.totals?.scope === 1,
    `status ${bd.status} ${JSON.stringify(bd.json?.totals)}`,
  );

  if (!hasAgentBrowser()) {
    console.log("  [SKIP] browser epic board (agent-browser not on PATH, or E2E_UI_BROWSER=0)");
    return;
  }
  try {
    const base = new URL(BASE);
    for (const [name, value] of jar) agentBrowser(["cookies", "set", name, value, "--url", `${base.origin}/`]);
    agentBrowser(["open", `${BASE}/v/ui-vault/board?group=epic`]);
    // The card pickers are disabled until hydrated: wait for them, never a sleep.
    const ready = await browserUntil(
      `(() => { const s = document.querySelector('.epic-pick select'); return !!s && !s.disabled; })()`,
    );
    step("browser: the epic board hydrates (pickers enabled)", ready !== null);
    if (process.env.E2E_UI_SCREENSHOT) {
      agentBrowser(["screenshot", "--full", process.env.E2E_UI_SCREENSHOT.replace(/(\.png)?$/, "-board-epics.png")]);
    }
    // Move the inherited task to Platform with its card's epic picker.
    agentBrowser([
      "eval",
      `(() => { const card = [...document.querySelectorAll('.task-card')].find((c) => c.textContent.includes('Epic feature task')); if (!card) return 'no card'; const s = card.querySelector('.epic-pick select'); s.value = 'platform-epic'; s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`,
    ]);
    const lane = await browserUntil(
      `[...document.querySelectorAll('[aria-label="Epic: Platform"] .task-card')].some((c) => c.textContent.includes('Epic feature task'))`,
    );
    step("browser: the epic picker moves a card into the other epic's lane", lane !== null);
    let after = [];
    const storedDeadline = Date.now() + BROWSER_DEADLINE_MS;
    while (Date.now() < storedDeadline) {
      after = await edgesOf(inherited.json?.id);
      if (after.includes("platform-epic")) break;
      await sleep(500);
    }
    step("browser: the move is stored server-side", after.includes("platform-epic"), JSON.stringify(after));
    // Collapse the Checkout lane; the choice survives a reload.
    agentBrowser(["click", '[aria-label="Epic: Checkout v2"] .epic-toggle']);
    const stored = await browserUntil(`(localStorage.getItem('brainz:board:epic-collapsed:' + '${vaultId}') ?? '').includes('checkout-epic')`);
    step("browser: collapsing a lane stores it", stored !== null);
    agentBrowser(["open", `${BASE}/v/ui-vault/board?group=epic`]);
    // Collapse state is restored on mount, so wait for the toggle to report it.
    const collapsed = await browserUntil(
      `document.querySelector('[aria-label="Epic: Checkout v2"] .epic-toggle')?.getAttribute('aria-expanded') === 'false'`,
    );
    step("browser: a collapsed epic lane stays collapsed after reload", collapsed !== null);
  } finally {
    spawnSync("agent-browser", ["--session", "brainz-e2e-ui", "close"]);
  }
}

async function featuresJourney() {
  // Runs after epicJourney: checkout-epic (Checkout v2) ← pay-button ← "Epic
  // feature task", plus the earlier domain-linked tasks.
  const ft = await page("/v/ui-vault/features");
  step("/v/ui-vault/features → 200", ft.status === 200, `status ${ft.status}`);
  step(
    "features SSR: the tree renders nodes with a roll-up state",
    ft.html.includes('aria-label="Feature tree"') && /data-state="(not-started|in-progress|done|blocked|empty)"/.test(ft.html),
  );
  step("features SSR: tasks-done count and links to the other views", /\d+\/\d+ tasks done/.test(ft.html) && ft.html.includes("/v/ui-vault/board"));
  const ws = await page("/v/ui-vault");
  step("workspace links to the features tab", ws.html.includes("/v/ui-vault/features"));
  // "Show on board" lands on the epic board narrowed to the node's closure.
  // Card titles only: the hydration data still carries the whole pile.
  const scoped = await page("/v/ui-vault/board?group=epic&scope=pay-button");
  const cards = [...scoped.html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((m) => m[1].replace(/<!--.*?-->/g, "").trim());
  step(
    "board ?scope= narrows to the subtree (closure)",
    scoped.status === 200 && scoped.html.includes('data-scope="pay-button"') && cards.includes("Epic feature task") && !cards.includes("Ship the board"),
    `status ${scoped.status} cards ${JSON.stringify(cards)}`,
  );

  if (!hasAgentBrowser()) {
    console.log("  [SKIP] browser features tree (agent-browser not on PATH, or E2E_UI_BROWSER=0)");
    return;
  }
  try {
    const base = new URL(BASE);
    for (const [name, value] of jar) agentBrowser(["cookies", "set", name, value, "--url", `${base.origin}/`]);
    const featuresUrl = `${BASE}/v/ui-vault/features`;
    const hydratedExpr = `document.querySelector('.ft-page')?.dataset.hydrated === 'true'`;
    agentBrowser(["open", featuresUrl]);
    // Controls are disabled until hydrated: wait for the marker, never a sleep.
    let ready = await browserUntil(hydratedExpr, { timeoutMs: Math.min(60_000, BROWSER_DEADLINE_MS) });
    if (ready === null) {
      // A gate run once fell back to SvelteKit's error page while loading the
      // route's modules (not reproducible). Report what the browser saw, then
      // load the page once more: a real client error fails again below.
      console.log(`  [NOTE] the features tree did not hydrate on first load; reloading once — ${browserDiagnostics()}`);
      agentBrowser(["open", featuresUrl]);
      ready = await browserUntil(hydratedExpr);
    }
    step("browser: the features tree hydrates", ready !== null, ready === null ? browserDiagnostics() : "");
    if (ready === null) return; // the clicks below need a hydrated tree
    if (process.env.E2E_UI_SCREENSHOT) {
      agentBrowser(["screenshot", "--full", process.env.E2E_UI_SCREENSHOT.replace(/(\.png)?$/, "-features.png")]);
    }
    // Collapse to the roots and frame them, then open one epic.
    const clickControl = (label) =>
      browserUntil(
        `(() => { const b = [...document.querySelectorAll('.ft-page .controls .chip')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return ''; b.click(); return 'clicked'; })()`,
      );
    const collapsed = (await clickControl("Collapse all")) !== null && (await clickControl("Fit")) !== null;
    step("browser: the Collapse all and Fit controls respond", collapsed, collapsed ? "" : browserDiagnostics());
    if (!collapsed) return;
    const root = await browserUntil(
      `!document.querySelector('[data-id="pay-button"]') && !!document.querySelector('[data-id="checkout-epic"]')`,
    );
    step("browser: Collapse all leaves the roots (the epic is one)", root !== null);
    if (root === null) return; // the epic node is needed below
    agentBrowser(["click", '[data-id="checkout-epic"] .toggle']);
    const opened = await browserUntil(`!!document.querySelector('[data-id="pay-button"]')`);
    step("browser: expanding the epic reveals its feature", opened !== null);
    agentBrowser(["click", '[data-id="checkout-epic"]']);
    const link = await browserUntil(`document.querySelector('.panel-actions a')?.getAttribute('href') ?? ''`);
    step(
      "browser: clicking a node opens the panel with Show on board",
      Boolean(link?.includes("/v/ui-vault/board?group=epic&scope=checkout-epic")),
      link ?? "(timed out)",
    );
    if (process.env.E2E_UI_SCREENSHOT) {
      agentBrowser(["screenshot", "--full", process.env.E2E_UI_SCREENSHOT.replace(/(\.png)?$/, "-features-panel.png")]);
    }
    if (!link) return; // no panel, so nothing to follow
    agentBrowser(["eval", `document.querySelector('.panel-actions a')?.click()`]);
    const chip = await browserUntil(`document.querySelector('.scope-chip')?.dataset.scope ?? ''`);
    step("browser: Show on board opens the board scoped to the node", chip === "checkout-epic", chip ?? "(timed out)");
  } finally {
    spawnSync("agent-browser", ["--session", "brainz-e2e-ui", "close"]);
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

// ----------------------------------------------------------------- dreaming

/** The settings page's per-vault Dreaming card + its REST surface (SPEC-CLOUD "Per-vault settings"). */
async function dreamingJourney(vaultId, settingsHtml) {
  step(
    "settings SSR has the vault Dreaming card with editor controls + diary",
    settingsHtml.includes("Dreaming for this vault") &&
      settingsHtml.includes("Save dreaming settings") &&
      settingsHtml.includes("Dream Diary"),
  );
  const got = await api("GET", `/api/vaults/${vaultId}/dreaming`);
  step(
    "GET dreaming → 200 with default settings",
    got.status === 200 && got.json?.status?.settings?.mode === "apply" && Array.isArray(got.json?.entries),
    `status ${got.status}`,
  );
  const patched = await api("PATCH", `/api/vaults/${vaultId}/dreaming`, {
    body: { mode: "propose", runHourUtc: 3, caps: { maxLinks: 4 }, phases: { contradictions: false } },
  });
  const s = patched.json?.status?.settings;
  step(
    "PATCH dreaming → settings merged (mode, run hour, caps, phases)",
    patched.status === 200 &&
      s?.mode === "propose" &&
      s?.runHourUtc === 3 &&
      s?.caps?.maxLinks === 4 &&
      s?.caps?.maxMerges === 5 &&
      s?.phases?.contradictions === false,
    `status ${patched.status}`,
  );
  const loose = await api("PATCH", `/api/vaults/${vaultId}/dreaming`, { body: { lossRail: { maxTouchFraction: 0.5 } } });
  step("PATCH a looser loss rail → 400", loose.status === 400, `status ${loose.status}`);
  const missing = await api("POST", `/api/vaults/${vaultId}/dreaming/dream-nope/apply`, { body: {} });
  step("apply an unknown dream → 404", missing.status === 404, `status ${missing.status}`);

  if (!hasAgentBrowser()) {
    console.log("  [SKIP] browser dreaming card (agent-browser not on PATH, or E2E_UI_BROWSER=0)");
    return;
  }
  try {
    const base = new URL(BASE);
    for (const [name, value] of jar) agentBrowser(["cookies", "set", name, value, "--url", `${base.origin}/`]);
    agentBrowser(["open", `${BASE}/v/ui-vault/settings`]);
    // Wait on conditions (hydration, then the stored outcome) against a
    // deadline, never a fixed wait: under load hydration lands late, and a
    // select/submit before it is dropped.
    const hydrated = await browserUntil(
      `document.querySelector('main.page')?.dataset.hydrated === 'true' && !document.querySelector('[data-testid="vault-dreaming"] button[type="submit"]')?.disabled`,
    );
    step("browser: the settings page hydrates (dreaming save enabled)", hydrated !== null);
    const shown = (await browserUntil(`document.querySelector('select[aria-label="Dreaming mode"]')?.value ?? ''`)) ?? "";
    step("browser: the card shows the saved mode", shown === "propose", shown);
    agentBrowser(["select", 'select[aria-label="Dreaming mode"]', "light-only"]);
    agentBrowser(["click", '[data-testid="vault-dreaming"] button[type="submit"]']);
    let after = { status: 0, json: null };
    const savedDeadline = Date.now() + BROWSER_DEADLINE_MS;
    while (Date.now() < savedDeadline) {
      after = await api("GET", `/api/vaults/${vaultId}/dreaming`);
      if (after.json?.status?.settings?.mode === "light-only") break;
      await sleep(500);
    }
    step(
      "browser: saving the card persists the mode (other settings kept)",
      after.json?.status?.settings?.mode === "light-only" && after.json?.status?.settings?.caps?.maxLinks === 4,
      after.json?.status?.settings?.mode,
    );
    if (process.env.E2E_UI_SCREENSHOT) {
      agentBrowser(["screenshot", "--full", process.env.E2E_UI_SCREENSHOT.replace(/(\.png)?$/, "-dreaming.png")]);
    }
  } finally {
    spawnSync("agent-browser", ["--session", "brainz-e2e-ui", "close"]);
  }
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

const BROWSER_DEADLINE_MS = Number(process.env.E2E_UI_BROWSER_DEADLINE_MS ?? 120_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a page expression until it is truthy (not "", false, null, undefined)
 * or the deadline passes. Returns its value as a string, or null on timeout.
 * agent-browser's own waits cap at 25s; a loaded box needs more headroom.
 */
async function browserUntil(expr, { timeoutMs = BROWSER_DEADLINE_MS, everyMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const raw = agentBrowser(["eval", expr]).trim();
      const value = raw.replace(/^"|"$/g, "");
      if (value && !["false", "null", "undefined", "0"].includes(value)) return value;
    } catch {
      /* page still loading or navigating — try again */
    }
    await sleep(everyMs);
  } while (Date.now() < deadline);
  return null;
}

/** Where the browser is and what went wrong there, for a failed step's detail. */
function browserDiagnostics() {
  const run = (args) => {
    try {
      return agentBrowser(args).replace(/\s+/g, " ").slice(0, 600);
    } catch (err) {
      return `(${args[0]} failed: ${err instanceof Error ? err.message.slice(0, 200) : err})`;
    }
  };
  return [
    `at ${run(["eval", "location.href + ' | ' + document.title"])}`,
    `page errors: ${run(["errors"]) || "(none)"}`,
    `console: ${run(["console"]) || "(none)"}`,
  ].join(" — ");
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
    // Poll for it against the long deadline (agent-browser's own wait caps at 25s).
    await browserUntil(`!!document.querySelector(".search:not([hidden]) #vault-search")`);
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
    const deadline = Date.now() + BROWSER_DEADLINE_MS;
    while (callbacks.hits.length === 0 && Date.now() < deadline) await sleep(100);
    // Then a short quiet window: a second (duplicate) callback would land here.
    await sleep(1500);
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
  // The consent journey creates ~10 vaults for one user within minutes; lift
  // the hourly creation limit (default 10) so it never trips here.
  const dev = spawn(
    "npx",
    [
      "wrangler", "dev", "--local", "--port", String(PORT), "--persist-to", STATE_DIR, "--show-interactive-dev-session=false",
      "--var", "VAULT_CREATE_RATE_LIMIT:100",
    ],
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

    // 6c. Burndown panel: an iteration with dates, a task assigned to it via
    // the concept PUT (what the board's iteration picker sends), a take +
    // complete, then the REST burndown and the SSR panel.
    await burndownJourney(vault.id, linkedTask.json);

    // 6d. Epics: the epic type, create_task's epic, the epic-grouped board
    // (lanes with status columns + roll-up), re-parenting, burndown scope.
    await epicJourney(vault.id);

    // 6e. Feature tree: /v/[slug]/features over the same epics and tasks,
    // and the board's ?scope= subtree filter behind "Show on board".
    await featuresJourney();

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
    await dreamingJourney(vault.id, settings.html);

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
