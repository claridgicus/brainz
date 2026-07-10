/**
 * MCP handler-map tests over a fake VaultClient, exercised through a real
 * MCP client via the SDK's InMemoryTransport — proves the /mcp tool surface
 * matches @brainz/contracts (names from MCP_TOOLS, outputs parse with each
 * outputSchema) without needing the Workers runtime.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  getMcpTool,
  MCP_TOOL_NAMES,
  onboardCompleteOutputSchema,
  onboardStatusOutputSchema,
  upsertConceptOutputSchema,
  vaultStatsOutputSchema,
} from "@brainz/contracts";
import { ONBOARDING_NUDGE, ONBOARDING_SUMMARY_ID } from "@brainz/engine";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer, type McpServerHooks } from "./mcp";
import type { VaultClient } from "./vault-client";

interface FakeVault extends VaultClient {
  /** Test seam: onboarded state + upserts recorded by the fake. */
  state: { onboardedAt: string | null; upserts: unknown[] };
}

function fakeVault(): FakeVault {
  const state: FakeVault["state"] = { onboardedAt: null, upserts: [] };
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
        { id: "lead-scoring", title: "Lead scoring", type: "feature", status: "active", tags: ["crm"] },
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
      embeddings: "unavailable",
      keywordIndex: "like",
    }),
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

  it("registers exactly the 9 contract tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(9);
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
    expect(blocks[0]).toContain("20–60 concepts");
    expect(blocks[0]).toContain("`domain`");
    expect(blocks[0]).toContain("realized_by");
    expect(blocks[0]).toContain("governs");
    expect(blocks[0]).toContain('{"action": "complete"');
  });

  it("status reports onboarded state + counts (contract shape)", async () => {
    const result = await client.callTool({ name: "onboard", arguments: { action: "status" } });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(onboardStatusOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({ onboarded: false, conceptCount: 1 });
  });

  it("complete requires a summary", async () => {
    const result = await client.callTool({ name: "onboard", arguments: { action: "complete" } });
    expect(result.isError).toBe(true);
    expect(textBlocks(result)[0]).toContain("summary");
  });

  it("complete stores the summary concept, sets DO state, mirrors to D1, and stops the nudge", async () => {
    const result = await client.callTool({
      name: "onboard",
      arguments: { action: "complete", summary: "Indexed 34 concepts across 5 domains." },
    });
    const payload = JSON.parse(textBlocks(result)[0]);
    expect(onboardCompleteOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload.summaryConceptId).toBe(ONBOARDING_SUMMARY_ID);
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
