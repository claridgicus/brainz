import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MCP_TOOLS, getContextOutputSchema, getMcpTool, type McpToolName } from "@brainz/contracts";
import { Vault } from "@brainz/core";
import { createServer, resolveVaultDir } from "../src/server.js";

const DEMO_VAULT = fileURLToPath(
  new URL("../../../examples/demo-vault", import.meta.url),
);

type TextContent = { type: "text"; text: string };

interface ToolResult {
  content: TextContent[];
  isError?: boolean;
}

let tmpVault: string;
let vault: Vault;
let client: Client;

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

/**
 * Call a tool and parse its single JSON text block, validating it against the
 * tool's contract outputSchema — the sync guarantee between server and contracts.
 */
async function callJson(name: McpToolName, args: Record<string, unknown> = {}): Promise<any> {
  const result = await callTool(name, args);
  expect(result.isError ?? false).toBe(false);
  const data = JSON.parse(result.content[0].text);
  const parsed = getMcpTool(name).outputSchema.safeParse(data);
  expect(
    parsed.success,
    `${name} output does not match contract outputSchema: ${
      parsed.success ? "" : JSON.stringify(parsed.error.issues)
    }`,
  ).toBe(true);
  return data;
}

beforeAll(async () => {
  // Work on a throwaway copy so the example vault stays pristine.
  tmpVault = await mkdtemp(path.join(tmpdir(), "brainz-mcp-test-"));
  await cp(DEMO_VAULT, tmpVault, { recursive: true });
  await rm(path.join(tmpVault, ".brainz"), { recursive: true, force: true });

  vault = await Vault.open(tmpVault);
  const server = createServer(vault);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterAll(async () => {
  await client?.close();
  vault?.close();
  await rm(tmpVault, { recursive: true, force: true });
});

describe("tool registration", () => {
  it("exposes the spec'd tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "complete_task",
      "create_task",
      "delete_concept",
      "dream",
      "get_concept",
      "get_context",
      "get_related",
      "link_concepts",
      "list_concepts",
      "list_tasks",
      "onboard",
      "search_concepts",
      "session_hook",
      "sync",
      "take_task",
      "upsert_concept",
      "vault_stats",
    ]);
    for (const tool of tools) {
      expect(tool.description ?? "").not.toBe("");
    }
  });

  it("registrations come verbatim from the @brainz/contracts registry", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(tools).toHaveLength(MCP_TOOLS.length);
    for (const contract of MCP_TOOLS) {
      const tool = byName.get(contract.name);
      expect(tool, contract.name).toBeDefined();
      expect(tool!.title).toBe(contract.title);
      expect(tool!.description).toBe(contract.description);
    }
  });
});

describe("search_concepts", () => {
  it("returns ranked hits for a real query", async () => {
    const data = await callJson("search_concepts", { query: "lead scoring" });
    expect(data.hits.length).toBeGreaterThan(0);
    const hit = data.hits[0];
    expect(hit).toHaveProperty("id");
    expect(hit).toHaveProperty("title");
    expect(hit).toHaveProperty("type");
    expect(hit).toHaveProperty("score");
    expect(hit).toHaveProperty("snippet");
    expect(data.hits.map((h: any) => h.id)).toContain("lead-scoring");
  });

  it("returns an empty list (not an error) for garbage", async () => {
    const data = await callJson("search_concepts", { query: "zzz )))(((" });
    expect(data.hits).toEqual([]);
  });

  it("respects type filter and limit", async () => {
    const data = await callJson("search_concepts", {
      query: "postgres",
      type: "decision",
      limit: 1,
    });
    expect(data.hits.length).toBeLessThanOrEqual(1);
    for (const hit of data.hits) expect(hit.type).toBe("decision");
  });
});

describe("get_concept", () => {
  it("returns body, meta, and direct neighbors for a known id", async () => {
    const data = await callJson("get_concept", { id: "lead-scoring" });
    expect(data.id).toBe("lead-scoring");
    expect(data.title).toBe("Lead Scoring");
    expect(data.type).toBe("feature");
    expect(data.body).toContain("score");
    expect(Array.isArray(data.neighbors)).toBe(true);
    const neighborIds = data.neighbors.map((n: any) => n.id);
    expect(neighborIds).toContain("contact-model");
    expect(neighborIds).toContain("email-campaigns");
    for (const n of data.neighbors) {
      expect(typeof n.relation).toBe("string");
      expect(["in", "out"]).toContain(n.direction);
    }
  });

  it("returns isError for an unknown id", async () => {
    const result = await callTool("get_concept", { id: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does-not-exist");
  });
});

describe("get_related", () => {
  it("traverses to the requested depth with via paths", async () => {
    const data = await callJson("get_related", { id: "auth-system", depth: 2 });
    expect(data.related.length).toBeGreaterThan(0);
    for (const node of data.related) {
      expect(node.distance).toBeGreaterThanOrEqual(1);
      expect(node.distance).toBeLessThanOrEqual(2);
      expect(node.via.length).toBeGreaterThan(0);
    }
    expect(data.related.some((n: any) => n.distance === 2)).toBe(true);
  });

  it("filters by relation names", async () => {
    const data = await callJson("get_related", {
      id: "lead-scoring",
      relations: ["depends_on"],
    });
    for (const node of data.related) {
      for (const edge of node.via) expect(edge.relation).toBe("depends_on");
    }
    expect(data.related.map((n: any) => n.id)).toContain("contact-model");
  });

  it("returns isError for an unknown id", async () => {
    const result = await callTool("get_related", { id: "nope-nope" });
    expect(result.isError).toBe(true);
  });
});

describe("get_context", () => {
  function parseBundle(result: ToolResult) {
    expect(result.isError ?? false).toBe(false);
    // Two-block convention: markdown briefing, then the JSON footer.
    expect(result.content.length).toBe(2);
    const parsed = getContextOutputSchema.safeParse(JSON.parse(result.content[1].text));
    expect(
      parsed.success,
      `get_context footer does not match contract outputSchema: ${
        parsed.success ? "" : JSON.stringify(parsed.error.issues)
      }`,
    ).toBe(true);
    return { markdown: result.content[0].text, footer: parsed.data! };
  }

  it("assembles a bundle from a query", async () => {
    const result = await callTool("get_context", { query: "authentication sessions" });
    const { markdown, footer } = parseBundle(result);
    expect(markdown).toContain("## ");
    expect(footer.included.length).toBeGreaterThan(0);
    expect(footer.approxTokens).toBeGreaterThan(0);
    expect(markdown).toContain("(auth-system)");
  });

  it("assembles a bundle from explicit ids", async () => {
    const result = await callTool("get_context", { ids: ["mrr"], depth: 0 });
    const { markdown, footer } = parseBundle(result);
    expect(footer.included).toEqual(["mrr"]);
    expect(markdown).toContain("(mrr)");
  });

  it("respects the token budget", async () => {
    const result = await callTool("get_context", {
      query: "leads contacts campaigns",
      depth: 2,
      tokenBudget: 300,
    });
    const { footer } = parseBundle(result);
    expect(footer.approxTokens).toBeLessThanOrEqual(300);
    expect(footer.truncated).toBe(true);
  });

  it("errors when neither query nor ids is given", async () => {
    const result = await callTool("get_context", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/query.*ids|ids.*query/);
  });
});

describe("upsert_concept and link_concepts", () => {
  it("round-trips an upserted concept through get_concept", async () => {
    const saved = await callJson("upsert_concept", {
      title: "Webhook Retries",
      body: "Retries use exponential backoff via the [[outbox-pattern]].",
      type: "pattern",
      product: "acme-crm",
      tags: ["reliability"],
    });
    expect(saved.id).toBe("webhook-retries");
    expect(saved.type).toBe("pattern");

    const fetched = await callJson("get_concept", { id: "webhook-retries" });
    expect(fetched.title).toBe("Webhook Retries");
    expect(fetched.body).toContain("exponential backoff");
    // The wiki-link created an edge.
    expect(fetched.neighbors.map((n: any) => n.id)).toContain("outbox-pattern");
  });

  it("errors on an empty title", async () => {
    const result = await callTool("upsert_concept", { title: "   ", body: "x" });
    expect(result.isError).toBe(true);
  });

  it("links two concepts and the edge shows up in get_related", async () => {
    const data = await callJson("link_concepts", {
      from: "webhook-retries",
      to: "rate-limiting",
      relation: "depends_on",
    });
    expect(data.ok).toBe(true);

    const related = await callJson("get_related", {
      id: "webhook-retries",
      relations: ["depends_on"],
    });
    expect(related.related.map((n: any) => n.id)).toContain("rate-limiting");
  });

  it("errors when linking from an unknown concept", async () => {
    const result = await callTool("link_concepts", { from: "ghost", to: "mrr" });
    expect(result.isError).toBe(true);
  });
});

describe("delete_concept", () => {
  it("deletes a concept and its edges, then get_concept no longer finds it", async () => {
    // Seed a concept with an outgoing wiki-link edge.
    await callJson("upsert_concept", {
      id: "junk-node",
      title: "Junk Node",
      body: "Delete me. [[mrr]]",
      type: "concept",
    });
    const before = await callJson("get_related", { id: "mrr", depth: 1 });
    expect(before.related.map((n: any) => n.id)).toContain("junk-node");

    const result = await callJson("delete_concept", { id: "junk-node" });
    expect(result).toEqual({ deleted: true, id: "junk-node" });

    // Gone from the index: get_concept errors, and the edge is gone too.
    const fetched = await callTool("get_concept", { id: "junk-node" });
    expect(fetched.isError).toBe(true);
    const after = await callJson("get_related", { id: "mrr", depth: 1 });
    expect(after.related.map((n: any) => n.id)).not.toContain("junk-node");
  });

  it("deleting a missing id is a clean no-op success (deleted:false), not an error", async () => {
    const result = await callJson("delete_concept", { id: "does-not-exist" });
    expect(result).toEqual({ deleted: false, id: "does-not-exist" });
  });
});

describe("list_concepts and vault_stats", () => {
  it("lists metas with filters", async () => {
    const all = await callJson("list_concepts", {});
    expect(all.count).toBeGreaterThanOrEqual(13);
    const decisions = await callJson("list_concepts", { type: "decision" });
    expect(decisions.count).toBeGreaterThan(0);
    for (const c of decisions.concepts) expect(c.type).toBe("decision");
  });

  it("reports vault stats with counts and embedding status", async () => {
    const stats = await callJson("vault_stats", {});
    expect(stats.concepts).toBeGreaterThanOrEqual(13);
    expect(stats.edges).toBeGreaterThan(0);
    expect(stats.products).toContain("acme-crm");
    expect(stats.byType.decision).toBeGreaterThan(0);
    // demo vault config: provider "none"
    expect(stats.embeddings).toBe("unavailable");
  });
});

describe("resources", () => {
  it("lists concepts as resources and reads one", async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBeGreaterThanOrEqual(13);
    const mrr = resources.find((r) => r.uri === "brainz://concept/mrr");
    expect(mrr).toBeDefined();

    const read = await client.readResource({ uri: "brainz://concept/mrr" });
    const text = (read.contents[0] as { text: string }).text;
    expect(text).toContain("MRR");
  });
});

describe("code areas", () => {
  it("upsert_concept round-trips codeAreas through get_concept and get_context", async () => {
    const saved = await callJson("upsert_concept", {
      title: "Session Refresh",
      body: "Rotates session tokens.",
      type: "feature",
      codeAreas: ["src/auth/session.ts", "src/routes/api/**"],
    });
    expect(saved.codeAreas).toEqual(["src/auth/session.ts", "src/routes/api/**"]);

    const fetched = await callJson("get_concept", { id: "session-refresh" });
    expect(fetched.codeAreas).toEqual(["src/auth/session.ts", "src/routes/api/**"]);

    // Frontmatter stores it as code_areas.
    const raw = await (await import("node:fs/promises")).readFile(fetched.filePath, "utf8");
    expect(raw).toContain("code_areas:");

    // get_context sections carry the Code areas line.
    const result = await callTool("get_context", { ids: ["session-refresh"], depth: 0 });
    expect(result.content[0].text).toContain("Code areas: `src/auth/session.ts`, `src/routes/api/**`");
  });
});

describe("onboarding (onboard tool + nudge)", () => {
  it("un-onboarded: search_concepts carries the notice, get_context is prefixed", async () => {
    const search = await callJson("search_concepts", { query: "lead scoring" });
    expect(search.notice).toMatch(/not onboarded/);

    const ctx = await callTool("get_context", { ids: ["mrr"], depth: 0 });
    expect(ctx.content[0].text).toMatch(/^Note: this vault is not onboarded yet/);
  });

  it("start returns the playbook as one markdown block", async () => {
    const result = await callTool("onboard", { action: "start", productName: "Acme CRM" });
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toHaveLength(1);
    const playbook = result.content[0].text;
    expect(playbook).toContain("Onboarding playbook — Acme CRM");
    expect(playbook).not.toContain("20–60 concepts");
    expect(playbook).toContain("200–800+ concepts");
    expect(playbook).toContain('"action": "status"');
    expect(playbook).toContain("`domain`");
    expect(playbook).toContain("realized_by");
    expect(playbook).toContain("governs");
    expect(playbook).toContain("node_modules");
  });

  it("status with an areaList returns a coverage report", async () => {
    // The demo vault's concepts carry no code_areas, so every reported area is
    // uncovered — the report shape is what matters here.
    const status = await callJson("onboard", {
      action: "status",
      areaList: ["packages/engine", "packages/core", "apps/cloud/src"],
    });
    expect(status.onboarded).toBe(false);
    expect(Array.isArray(status.coverage.covered)).toBe(true);
    expect(status.coverage.uncovered).toEqual([
      "packages/engine",
      "packages/core",
      "apps/cloud/src",
    ]);
    expect(status.coverage.coveragePct).toBe(0);
  });

  it("complete with thin coverage (areaList) is rejected, listing uncovered areas", async () => {
    const result = await callTool("onboard", {
      action: "complete",
      summary: "Barely indexed.",
      areaList: ["packages/engine", "packages/core", "apps/cloud/src"],
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("onboarding looks incomplete");
    expect(text).toContain("packages/engine");
    // Gate fired before sealing — the vault is still un-onboarded.
    const status = await callJson("onboard", { action: "status" });
    expect(status.onboarded).toBe(false);
  });

  it("status reports un-onboarded with counts", async () => {
    const status = await callJson("onboard", { action: "status" });
    expect(status.onboarded).toBe(false);
    expect(status.conceptCount).toBeGreaterThanOrEqual(13);
    expect(status.byType.decision).toBeGreaterThan(0);
  });

  it("complete requires a summary", async () => {
    const result = await callTool("onboard", { action: "complete" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("summary");
  });

  it("complete stores the summary concept, persists config, and stops the nudge", async () => {
    const done = await callJson("onboard", {
      action: "complete",
      summary: "Indexed the acme-crm demo product.",
    });
    expect(done).toMatchObject({ ok: true, onboarded: true, summaryConceptId: "product-onboarding-summary" });
    // Quality signals surfaced on success. The demo vault has ≥13 concepts and
    // no `domain`-type concepts, so hasDomainConcepts is false; the lacking-
    // codeAreas count is a valid subset of the total.
    expect(done.conceptCount).toBeGreaterThanOrEqual(13);
    expect(done.conceptsLackingCodeAreas).toBeGreaterThanOrEqual(0);
    expect(done.conceptsLackingCodeAreas).toBeLessThanOrEqual(done.conceptCount);
    expect(done.hasDomainConcepts).toBe(false);
    expect(done.byType).toMatchObject({ feature: expect.any(Number) });

    const summary = await callJson("get_concept", { id: "product-onboarding-summary" });
    expect(summary.type).toBe("spec");
    expect(summary.body).toContain("acme-crm demo product");

    // onboardedAt persisted in brainz.config.json
    const fs = await import("node:fs/promises");
    const config = JSON.parse(await fs.readFile(path.join(tmpVault, "brainz.config.json"), "utf8"));
    expect(typeof config.onboardedAt).toBe("string");

    // vault_stats reports onboarded; nudges are gone.
    const stats = await callJson("vault_stats", {});
    expect(stats.onboarded).toBe(true);
    const search = await callJson("search_concepts", { query: "lead scoring" });
    expect(search.notice).toBeUndefined();
    const ctx = await callTool("get_context", { ids: ["mrr"], depth: 0 });
    expect(ctx.content[0].text.startsWith("Note: this vault is not onboarded")).toBe(false);

    const status = await callJson("onboard", { action: "status" });
    expect(status.onboarded).toBe(true);
  });

  it("start on an already-onboarded vault returns the idempotency guard, not the playbook", async () => {
    // Runs after the complete test above, so the vault is already onboarded.
    const result = await callTool("onboard", { action: "start", productName: "Acme CRM" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("already onboarded on");
    expect(text).toContain("duplicate concepts");
    expect(text).not.toContain("Onboarding playbook");
  });
});

describe("session defaults", () => {
  it("sends the use-Brainz-by-default instructions on initialize", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("every session");
    expect(instructions).toContain("`get_context`");
    expect(instructions).toContain("`upsert_concept`");
  });

  it("session_hook returns the playbook as one markdown block matching the contract", async () => {
    const result = await callTool("session_hook", { serverName: "acme-brain" });
    expect(result.isError ?? false).toBe(false);
    expect(result.content).toHaveLength(1);
    const playbook = result.content[0].text;
    expect(getMcpTool("session_hook").outputSchema.safeParse(playbook).success).toBe(true);
    expect(playbook).toMatch(/^# Session hook playbook/);
    expect(playbook).toContain("`acme-brain` MCP server");
    expect(playbook).toContain('"SessionStart"');
    expect(playbook).toContain("AGENTS.md");
  });

  it("session_hook {client} narrows to one harness", async () => {
    const result = await callTool("session_hook", { client: "other" });
    expect(result.content[0].text).not.toContain('"SessionStart"');
  });
});

describe("sync (drift playbook + staleness)", () => {
  // Runs after the onboarding block above, so the shared vault is onboarded and
  // freshly synced (onboarding is the initial sync point).
  it("start returns the DRIFT playbook (not the onboarding playbook)", async () => {
    const result = await callTool("sync", { action: "start", productName: "Acme CRM" });
    expect(result.isError ?? false).toBe(false);
    const playbook = result.content[0].text;
    expect(playbook).toContain("Sync playbook — Acme CRM");
    expect(playbook).not.toContain("Onboarding playbook");
    expect(playbook).toContain("Diff the codebase since the last sync");
    expect(playbook).toContain("Update stale concepts whose code_areas changed");
    expect(playbook).toContain("Index new / un-mapped work");
  });

  it("status reports onboarded, lastSyncedAt, and stale=false when fresh", async () => {
    const status = await callJson("sync", { action: "status" });
    expect(status.onboarded).toBe(true);
    expect(typeof status.lastSyncedAt).toBe("string");
    expect(status.stale).toBe(false);
  });

  it("complete APPENDS to the running summary log and re-stamps last_synced_at", async () => {
    const before = await callJson("get_concept", { id: "product-onboarding-summary" });
    expect(before.body).toContain("acme-crm demo product"); // the onboarding note

    const done = await callJson("sync", {
      action: "complete",
      summary: "Re-synced the scoring domain after the ranking change.",
    });
    expect(done).toMatchObject({ ok: true, summaryConceptId: "product-onboarding-summary" });
    expect(typeof done.lastSyncedAt).toBe("string");

    const after = await callJson("get_concept", { id: "product-onboarding-summary" });
    // Running log: the prior onboarding note AND the new sync note both survive.
    expect(after.body).toContain("acme-crm demo product");
    expect(after.body).toContain("Re-synced the scoring domain");
    expect(after.body).toContain("## Sync ");

    const fs = await import("node:fs/promises");
    const config = JSON.parse(await fs.readFile(path.join(tmpVault, "brainz.config.json"), "utf8"));
    expect(typeof config.lastSyncedAt).toBe("string");
  });

  it("complete requires a summary", async () => {
    const result = await callTool("sync", { action: "complete" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("summary");
  });
});

describe("resolveVaultDir", () => {
  it("prefers --vault over env and cwd", () => {
    expect(resolveVaultDir(["--vault", "/a/b"], { BRAINZ_VAULT: "/x" })).toBe(
      path.resolve("/a/b"),
    );
    expect(resolveVaultDir(["--vault=/a/c"], { BRAINZ_VAULT: "/x" })).toBe(
      path.resolve("/a/c"),
    );
  });

  it("falls back to BRAINZ_VAULT, then cwd", () => {
    expect(resolveVaultDir([], { BRAINZ_VAULT: "/from-env" })).toBe(path.resolve("/from-env"));
    expect(resolveVaultDir([], {})).toBe(process.cwd());
  });

  it("throws when --vault has no value", () => {
    expect(() => resolveVaultDir(["--vault"], {})).toThrow();
  });
});

describe("task tools", () => {
  it("create_task → list_tasks → take_task → complete_task round-trips", async () => {
    const created = await callJson("create_task", {
      title: "Wire up billing webhooks",
      body: "Handle Stripe events.",
      tags: ["high"],
      codeAreas: ["apps/billing/src/webhooks.ts"],
    });
    expect(created.type).toBe("task");
    expect(created.taskStatus).toBe("open");

    const list = await callJson("list_tasks", { taskStatus: "open" });
    expect(list.tasks.some((t: { id: string }) => t.id === created.id)).toBe(true);

    const taken = await callJson("take_task", { id: created.id, takenBy: "fleet-7" });
    expect(taken.task.taskStatus).toBe("taken");
    expect(taken.task.takenBy).toBe("fleet-7");
    expect(typeof taken.context.markdown).toBe("string");

    // Taking it again is an isError (already taken).
    const again = await callTool("take_task", { id: created.id });
    expect(again.isError).toBe(true);

    const done = await callJson("complete_task", { id: created.id, outcome: "Shipped." });
    expect(done.task.taskStatus).toBe("done");
    expect(done.reminder).toContain("upsert_concept");
  });
});

describe("dream tool (local)", () => {
  it("status → run (light only without an LLM) → diary, all matching the contract", async () => {
    const status = await callJson("dream", { action: "status" });
    expect(status).toMatchObject({ enabled: true, cadenceHours: 24, llm: null, inFlight: null });

    const run = await callJson("dream", { action: "run" });
    expect(run.status).toBe("done");
    expect(run.entry.status).toBe("light-only");
    expect(run.entry.rem.status).toBe("skipped");

    const diary = await callJson("dream", { action: "diary", limit: 5 });
    expect(diary.entries[0].id).toBe(run.id);

    const configured = await callJson("dream", { action: "configure", cadenceHours: 12 });
    expect(configured.cadenceHours).toBe(12);
    expect(configured.lastEntry.id).toBe(run.id);

    const stats = await callJson("vault_stats");
    expect(stats.lastDreamAt).toBe(configured.lastDreamAt);
  });

  it("revert without an id is an isError result, not a throw", async () => {
    const result = await callTool("dream", { action: "revert" });
    expect(result.isError).toBe(true);
  });
});
