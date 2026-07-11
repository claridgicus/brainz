/**
 * MCP handler-map tests over a fake VaultClient, exercised through a real
 * MCP client via the SDK's InMemoryTransport — proves the /mcp tool surface
 * matches @brainz/contracts (names from MCP_TOOLS, outputs parse with each
 * outputSchema) without needing the Workers runtime.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  claimOutputSchema,
  CLOUD_MCP_TOOLS,
  getMcpTool,
  MCP_TOOL_NAMES,
  onboardCompleteOutputSchema,
  onboardStatusOutputSchema,
  upsertConceptOutputSchema,
  vaultStatsOutputSchema,
} from "@brainz/contracts";
import { ONBOARDING_NUDGE, ONBOARDING_SUMMARY_ID } from "@brainz/engine";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer, ok, type McpServerHooks } from "./mcp";
import { VaultDoError, type VaultClient } from "./vault-client";

interface FakeTask {
  id: string;
  title: string;
  type: "task";
  status: "active";
  tags: string[];
  taskStatus: "open" | "taken" | "done";
  takenBy?: string;
  takenAt?: string;
  doneAt?: string;
  createdAt: string;
  body: string;
}

interface FakeVault extends VaultClient {
  /** Test seam: onboarded state + upserts + a small task pile recorded by the fake. */
  state: { onboardedAt: string | null; upserts: unknown[]; tasks: FakeTask[] };
}

function fakeVault(): FakeVault {
  const state: FakeVault["state"] = {
    onboardedAt: null,
    upserts: [],
    tasks: [
      {
        id: "task-a",
        title: "Task A",
        type: "task",
        status: "active",
        tags: ["high"],
        taskStatus: "open",
        createdAt: "2026-01-01T00:00:00.000Z",
        body: "Do the first thing.\n",
      },
      {
        id: "task-b",
        title: "Task B",
        type: "task",
        status: "active",
        tags: [],
        taskStatus: "open",
        createdAt: "2026-01-02T00:00:00.000Z",
        body: "Do the second thing.\n",
      },
    ],
  };
  const taskMeta = (t: FakeTask) => ({
    id: t.id,
    title: t.title,
    type: t.type,
    status: t.status,
    tags: t.tags,
    taskStatus: t.taskStatus,
    ...(t.takenBy !== undefined ? { takenBy: t.takenBy } : {}),
    ...(t.takenAt !== undefined ? { takenAt: t.takenAt } : {}),
    ...(t.doneAt !== undefined ? { doneAt: t.doneAt } : {}),
    createdAt: t.createdAt,
  });
  const concept = {
    id: "lead-scoring",
    title: "Lead scoring",
    type: "feature" as const,
    status: "active" as const,
    tags: ["crm"],
    codeAreas: ["apps/crm/src/scoring/**"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    body: "Scores leads. [[auth-system]]\n",
  };
  return {
    state,
    upsertConcept: async (input) => {
      state.upserts.push(input);
      return {
        concept: {
          ...concept,
          id: input.id ?? "lead-scoring",
          title: input.title,
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.codeAreas !== undefined ? { codeAreas: input.codeAreas } : {}),
          ...(input.taskStatus !== undefined ? { taskStatus: input.taskStatus } : {}),
          ...(input.takenBy !== undefined ? { takenBy: input.takenBy } : {}),
          ...(input.takenAt !== undefined ? { takenAt: input.takenAt } : {}),
          ...(input.doneAt !== undefined ? { doneAt: input.doneAt } : {}),
        },
      };
    },
    deleteConcept: async () => ({ ok: true, deleted: true }),
    getConcept: async (id) =>
      id === "lead-scoring"
        ? {
            concept: {
              ...concept,
              neighbors: [
                {
                  id: "auth-system",
                  title: "Auth",
                  type: "feature" as const,
                  status: "active" as const,
                  tags: [],
                  relation: "references",
                  direction: "out" as const,
                },
              ],
            },
          }
        : { concept: null },
    list: async () => ({
      count: 1,
      concepts: [
        {
          id: "lead-scoring",
          title: "Lead scoring",
          type: "feature",
          status: "active",
          tags: ["crm"],
          codeAreas: ["apps/crm/src/scoring/**"],
        },
      ],
    }),
    search: async () => ({
      hits: [{ id: "lead-scoring", title: "Lead scoring", type: "feature", score: 1.5, snippet: "Scores leads." }],
    }),
    related: async () => ({
      id: "lead-scoring",
      related: [
        {
          id: "auth-system",
          title: "Auth",
          type: "feature",
          status: "active",
          tags: [],
          distance: 1,
          via: [{ from: "lead-scoring", to: "auth-system", relation: "references" }],
        },
      ],
    }),
    graph: async () => ({ nodes: [], edges: [] }),
    context: async () => ({
      markdown: "## Lead scoring (lead-scoring)\n\nScores leads.",
      included: [
        { id: "lead-scoring", title: "Lead scoring", type: "feature", status: "active", tags: ["crm"] },
      ],
      truncated: false,
      approxTokens: 12,
    }),
    stats: async () => ({
      concepts: 1,
      edges: 1,
      products: [],
      tags: ["crm"],
      byType: { feature: 1 },
      onboarded: state.onboardedAt !== null,
      openTasks: state.tasks.filter((t) => t.taskStatus === "open").length,
      embeddings: "unavailable",
      keywordIndex: "like",
    }),
    listTasks: async (filter = {}) => {
      const tasks = state.tasks
        .filter((t) => !filter.taskStatus || t.taskStatus === filter.taskStatus)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(taskMeta);
      return { count: tasks.length, tasks };
    },
    takeTask: async (args = {}) => {
      const open = state.tasks
        .filter((t) => t.taskStatus === "open")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const target = args.id ? state.tasks.find((t) => t.id === args.id) : open[0];
      if (!target) throw new VaultDoError("no open tasks to take", 400);
      if (target.taskStatus !== "open")
        throw new VaultDoError(`task "${target.id}" is already ${target.taskStatus}`, 400);
      target.taskStatus = "taken";
      target.takenBy = args.takenBy ?? "an agent";
      target.takenAt = "2026-02-01T00:00:00.000Z";
      return {
        task: taskMeta(target),
        body: target.body,
        context: {
          markdown: `## ${target.title} (${target.id})\n\n${target.body}`,
          included: [target.id],
          truncated: false,
          approxTokens: 8,
        },
      };
    },
    completeTask: async (args) => {
      const target = state.tasks.find((t) => t.id === args.id);
      if (!target) throw new VaultDoError(`no task with id "${args.id}"`, 404);
      target.taskStatus = "done";
      target.doneAt = "2026-02-02T00:00:00.000Z";
      target.body = `${target.body}\n## Outcome\n\n${args.outcome}\n`;
      return { task: taskMeta(target), reminder: "index what changed via upsert_concept" };
    },
    reopenTask: async (args) => {
      const target = state.tasks.find((t) => t.id === args.id);
      if (!target) throw new VaultDoError(`no task with id "${args.id}"`, 404);
      target.taskStatus = "open";
      delete target.takenBy;
      delete target.takenAt;
      delete target.doneAt;
      return { task: taskMeta(target) };
    },
    onboarding: async () => ({ onboardedAt: state.onboardedAt }),
    setOnboardedAt: async (onboardedAt) => {
      state.onboardedAt = onboardedAt;
      return { ok: true, onboardedAt };
    },
    link: async (args) => ({ ok: true, from: args.from, to: args.to, relation: args.relation ?? "related_to" }),
    destroy: async () => ({ ok: true }),
  };
}

async function connect(
  vault: VaultClient = fakeVault(),
  hooks: McpServerHooks = {},
): Promise<Client> {
  const server = buildMcpServer(vault, hooks);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textBlocks(result: Awaited<ReturnType<Client["callTool"]>>): string[] {
  return (result.content as { type: string; text: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text);
}

describe("remote MCP server (contract registry)", () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect();
  });

  it("registers exactly the contract tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(MCP_TOOL_NAMES.length);
  });

  it("search_concepts output parses with the contract outputSchema", async () => {
    const result = await client.callTool({ name: "search_concepts", arguments: { query: "leads" } });
    const parsed = getMcpTool("search_concepts").outputSchema.safeParse(
      JSON.parse(textBlocks(result)[0]),
    );
    expect(parsed.success).toBe(true);
  });

  it("get_concept output includes a synthetic filePath and parses", async () => {
    const result = await client.callTool({ name: "get_concept", arguments: { id: "lead-scoring" } });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(payload.filePath).toBe("concepts/lead-scoring.md");
    expect(getMcpTool("get_concept").outputSchema.safeParse(payload).success).toBe(true);
  });

  it("get_concept on a missing id is an isError result, not a thrown error", async () => {
    const result = await client.callTool({ name: "get_concept", arguments: { id: "nope" } });
    expect(result.isError).toBe(true);
    expect(textBlocks(result)[0]).toContain('no concept with id "nope"');
  });

  it("get_context responds with the two-block convention", async () => {
    const result = await client.callTool({ name: "get_context", arguments: { query: "leads" } });
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("## Lead scoring");
    const footer = getMcpTool("get_context").outputSchema.safeParse(JSON.parse(blocks[1]));
    expect(footer.success).toBe(true);
  });

  it("get_context without query or ids fails gracefully", async () => {
    const result = await client.callTool({ name: "get_context", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("upsert_concept output parses (strict, with filePath)", async () => {
    const result = await client.callTool({
      name: "upsert_concept",
      arguments: { title: "New note", body: "hello" },
    });
    const parsed = upsertConceptOutputSchema.strict().safeParse(JSON.parse(textBlocks(result)[0]));
    expect(parsed.success).toBe(true);
  });

  it("vault_stats drops the cloud-only keywordIndex field (strict contract shape)", async () => {
    const result = await client.callTool({ name: "vault_stats", arguments: {} });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(payload).not.toHaveProperty("keywordIndex");
    expect(vaultStatsOutputSchema.strict().safeParse(payload).success).toBe(true);
  });

  it("list_concepts and get_related parse with their contract schemas", async () => {
    const list = await client.callTool({ name: "list_concepts", arguments: {} });
    expect(
      getMcpTool("list_concepts").outputSchema.safeParse(JSON.parse(textBlocks(list)[0])).success,
    ).toBe(true);
    const related = await client.callTool({
      name: "get_related",
      arguments: { id: "lead-scoring" },
    });
    expect(
      getMcpTool("get_related").outputSchema.safeParse(JSON.parse(textBlocks(related)[0])).success,
    ).toBe(true);
  });

  it("get_concept carries codeAreas through to the wire", async () => {
    const result = await client.callTool({ name: "get_concept", arguments: { id: "lead-scoring" } });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(payload.codeAreas).toEqual(["apps/crm/src/scoring/**"]);
    expect(getMcpTool("get_concept").outputSchema.safeParse(payload).success).toBe(true);
  });
});

describe("task tools", () => {
  let client: Client;
  beforeEach(async () => {
    client = await connect();
  });

  it("list_tasks returns tasks oldest-first, parsing with the contract schema", async () => {
    const result = await client.callTool({ name: "list_tasks", arguments: {} });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(payload.tasks.map((t: { id: string }) => t.id)).toEqual(["task-a", "task-b"]);
    expect(getMcpTool("list_tasks").outputSchema.safeParse(payload).success).toBe(true);
  });

  it("take_task claims the next open task and returns a context bundle", async () => {
    const result = await client.callTool({ name: "take_task", arguments: { takenBy: "fleet-1" } });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(payload.task.id).toBe("task-a");
    expect(payload.task.taskStatus).toBe("taken");
    expect(payload.task.takenBy).toBe("fleet-1");
    expect(payload.context.markdown).toContain("task-a");
    expect(getMcpTool("take_task").outputSchema.safeParse(payload).success).toBe(true);
  });

  it("take_task rejects an already-taken task as an isError result", async () => {
    await client.callTool({ name: "take_task", arguments: { id: "task-a" } });
    const again = await client.callTool({ name: "take_task", arguments: { id: "task-a" } });
    expect(again.isError).toBe(true);
    expect(textBlocks(again)[0]).toContain("already taken");
  });

  it("complete_task marks done and reminds the caller to index changes", async () => {
    await client.callTool({ name: "take_task", arguments: { id: "task-a" } });
    const result = await client.callTool({
      name: "complete_task",
      arguments: { id: "task-a", outcome: "Shipped it." },
    });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(payload.task.taskStatus).toBe("done");
    expect(payload.reminder).toContain("upsert_concept");
    expect(getMcpTool("complete_task").outputSchema.safeParse(payload).success).toBe(true);
  });

  it("create_task creates an open task-type concept", async () => {
    const result = await client.callTool({
      name: "create_task",
      arguments: { title: "New work", body: "Do a thing", domain: "auth", tags: ["high"] },
    });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(payload.type).toBe("task");
    expect(payload.taskStatus).toBe("open");
    expect(getMcpTool("create_task").outputSchema.safeParse(payload).success).toBe(true);
  });
});

describe("onboard tool + nudge", () => {
  let vault: FakeVault;
  let client: Client;
  let mirrored: Date | null;
  beforeEach(async () => {
    vault = fakeVault();
    mirrored = null;
    client = await connect(vault, {
      onOnboarded: async (at) => {
        mirrored = at;
      },
    });
  });

  it("un-onboarded: search carries the notice and get_context markdown is prefixed", async () => {
    const search = await client.callTool({ name: "search_concepts", arguments: { query: "x" } });
    const payload = JSON.parse(textBlocks(search)[0]);
    expect(payload.notice).toBe(ONBOARDING_NUDGE);
    expect(getMcpTool("search_concepts").outputSchema.safeParse(payload).success).toBe(true);

    const ctx = await client.callTool({ name: "get_context", arguments: { query: "x" } });
    expect(textBlocks(ctx)[0].startsWith(ONBOARDING_NUDGE)).toBe(true);
  });

  it("start returns the playbook as one markdown block", async () => {
    const result = await client.callTool({
      name: "onboard",
      arguments: { action: "start", productName: "Acme CRM" },
    });
    const blocks = textBlocks(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("Onboarding playbook — Acme CRM");
    expect(blocks[0]).not.toContain("20–60 concepts");
    expect(blocks[0]).toContain("200–800+ concepts");
    expect(blocks[0]).toContain('"action": "status"');
    expect(blocks[0]).toContain("`domain`");
    expect(blocks[0]).toContain("realized_by");
    expect(blocks[0]).toContain("governs");
    expect(blocks[0]).toContain('{"action": "complete"');
  });

  it("start on an already-onboarded vault returns the idempotency guard, not the playbook", async () => {
    vault.state.onboardedAt = "2026-03-14T09:00:00.000Z";
    const result = await client.callTool({
      name: "onboard",
      arguments: { action: "start", productName: "Acme CRM" },
    });
    expect(result.isError).toBe(true);
    const text = textBlocks(result)[0];
    // Guard, with the onboarded date, pointing at the update paths — never the playbook.
    expect(text).toContain("already onboarded on 2026-03-14");
    expect(text).toContain("duplicate concepts");
    expect(text).not.toContain("Onboarding playbook");
  });

  it("status reports onboarded state + counts (contract shape)", async () => {
    const result = await client.callTool({ name: "onboard", arguments: { action: "status" } });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(onboardStatusOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({ onboarded: false, conceptCount: 1 });
    // No areaList → no coverage report.
    expect(payload.coverage).toBeUndefined();
  });

  it("status with an areaList returns a coverage report (covered vs uncovered)", async () => {
    const result = await client.callTool({
      name: "onboard",
      arguments: {
        action: "status",
        // fake vault's one concept is anchored under apps/crm/src/scoring/**
        areaList: ["apps/crm/src", "packages/engine", "apps/other"],
      },
    });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(onboardStatusOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.coverage.covered).toEqual(["apps/crm/src"]);
    expect(payload.coverage.uncovered).toEqual(["packages/engine", "apps/other"]);
    expect(payload.coverage.coveragePct).toBe(33);
  });

  it("complete requires a summary", async () => {
    const result = await client.callTool({ name: "onboard", arguments: { action: "complete" } });
    expect(result.isError).toBe(true);
    expect(textBlocks(result)[0]).toContain("summary");
  });

  it("complete over an empty vault is rejected (no 'onboarded but empty' dead state)", async () => {
    // Empty graph: stats reports 0 concepts and list is empty.
    vault.stats = async () => ({
      concepts: 0,
      edges: 0,
      products: [],
      tags: [],
      byType: {},
      onboarded: false,
      openTasks: 0,
      embeddings: "unavailable",
      keywordIndex: "like",
    });
    vault.list = async () => ({ count: 0, concepts: [] });
    const result = await client.callTool({
      name: "onboard",
      arguments: { action: "complete", summary: "Nothing indexed yet." },
    });
    expect(result.isError).toBe(true);
    expect(textBlocks(result)[0]).toContain("no concepts");
    // Guard fired before any state change: still not onboarded.
    expect(vault.state.onboardedAt).toBeNull();
  });

  it("complete with THIN coverage (areaList) is rejected, listing uncovered areas", async () => {
    // Only 1 concept, anchored under apps/crm/src/scoring. Report 4 areas →
    // 3 uncovered (75% > 40% threshold) → reject.
    const result = await client.callTool({
      name: "onboard",
      arguments: {
        action: "complete",
        summary: "Indexed only scoring.",
        areaList: ["apps/crm/src", "packages/engine", "packages/core", "apps/api"],
      },
    });
    expect(result.isError).toBe(true);
    const text = textBlocks(result)[0];
    expect(text).toContain("onboarding looks incomplete");
    expect(text).toContain("packages/engine");
    expect(text).toContain("packages/core");
    expect(text).toContain("apps/api");
    // Gate fired before any state change.
    expect(vault.state.onboardedAt).toBeNull();
    expect(mirrored).toBeNull();
  });

  it("complete with BROAD coverage (areaList) succeeds and returns coverage", async () => {
    // 1 area, satisfied by the one concept → 0% uncovered → passes the gate.
    const result = await client.callTool({
      name: "onboard",
      arguments: {
        action: "complete",
        summary: "Indexed the scoring domain thoroughly.",
        areaList: ["apps/crm/src"],
      },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(onboardCompleteOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.coverage.covered).toEqual(["apps/crm/src"]);
    expect(payload.coverage.uncovered).toEqual([]);
    expect(payload.coverage.coveragePct).toBe(100);
    expect(vault.state.onboardedAt).not.toBeNull();
  });

  it("complete WITHOUT areaList warns via coverageNote but does not hard-block", async () => {
    const result = await client.callTool({
      name: "onboard",
      arguments: { action: "complete", summary: "Indexed the product." },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(onboardCompleteOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.coverage).toBeUndefined();
    expect(payload.coverageNote).toContain("coverage was not verified");
    expect(vault.state.onboardedAt).not.toBeNull();
  });

  it("complete still guards the empty vault even when an areaList is supplied", async () => {
    vault.stats = async () => ({
      concepts: 0,
      edges: 0,
      products: [],
      tags: [],
      byType: {},
      onboarded: false,
      openTasks: 0,
      embeddings: "unavailable",
      keywordIndex: "like",
    });
    vault.list = async () => ({ count: 0, concepts: [] });
    const result = await client.callTool({
      name: "onboard",
      arguments: {
        action: "complete",
        summary: "Nothing yet.",
        areaList: ["apps/crm/src"],
      },
    });
    expect(result.isError).toBe(true);
    expect(textBlocks(result)[0]).toContain("no concepts");
    expect(vault.state.onboardedAt).toBeNull();
  });

  it("complete stores the summary concept, sets DO state, mirrors to D1, and stops the nudge", async () => {
    const result = await client.callTool({
      name: "onboard",
      arguments: { action: "complete", summary: "Indexed 34 concepts across 5 domains." },
    });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(onboardCompleteOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.summaryConceptId).toBe(ONBOARDING_SUMMARY_ID);
    // Quality signals surfaced on success (fake vault: 1 feature concept,
    // anchored with codeAreas → none lacking).
    expect(payload.conceptCount).toBe(1);
    expect(payload.conceptsLackingCodeAreas).toBe(0);
    expect(payload.hasDomainConcepts).toBe(false);
    expect(payload.byType).toEqual({ feature: 1 });
    expect(vault.state.onboardedAt).not.toBeNull();
    expect(mirrored).toBeInstanceOf(Date);
    expect(vault.state.upserts).toContainEqual(
      expect.objectContaining({ id: ONBOARDING_SUMMARY_ID, type: "spec" }),
    );

    // Nudge gone once onboarded.
    const search = await client.callTool({ name: "search_concepts", arguments: { query: "x" } });
    expect(JSON.parse(textBlocks(search)[0]).notice).toBeUndefined();
    const ctx = await client.callTool({ name: "get_context", arguments: { query: "x" } });
    expect(textBlocks(ctx)[0].startsWith(ONBOARDING_NUDGE)).toBe(false);

    const status = await client.callTool({ name: "onboard", arguments: { action: "status" } });
    expect(JSON.parse(textBlocks(status)[0]).onboarded).toBe(true);
  });
});

describe("extraTools hook (cloud-only registrations, e.g. claim)", () => {
  it("registers CLOUD_MCP_TOOLS alongside the vault tools and routes calls to the handler", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = await connect(fakeVault(), {
      extraTools: CLOUD_MCP_TOOLS.map((def) => ({
        def,
        handler: async (args: Record<string, unknown>) => {
          calls.push(args);
          return ok({ status: "sent", expiresAt: "2026-07-11T00:00:00.000Z" });
        },
      })),
    });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...MCP_TOOL_NAMES, "claim"].sort(),
    );

    const result = await client.callTool({
      name: "claim",
      arguments: { email: "human@example.com" },
    });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(claimOutputSchema.safeParse(payload).success).toBe(true);
    expect(calls).toEqual([{ email: "human@example.com" }]);
  });

  it("without the hook, the surface stays exactly MCP_TOOLS (no claim)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("claim");
  });
});
