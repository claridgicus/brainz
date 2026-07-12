/**
 * Error/edge paths of the remote MCP handler map that mcp.test.ts leaves
 * open: link_concepts (happy + 404), get_related 404, DO failures surfacing
 * as isError (never protocol errors), and get_context budget/truncation
 * passthrough with explicit ids.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getMcpTool, linkConceptsOutputSchema } from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "./mcp";
import { VaultDoError, type VaultClient } from "./vault-client";

const META = {
  id: "auth-system",
  title: "Auth system",
  type: "feature" as const,
  status: "active" as const,
  tags: [] as string[],
};

/** A vault whose write/traverse calls fail like the real DO does. */
function vaultWith(overrides: Partial<VaultClient>): VaultClient {
  const notFound = (what: string) => {
    throw new VaultDoError(`no concept with id "${what}"`, 404);
  };
  const base: VaultClient = {
    upsertConcept: async (input) => ({
      concept: { ...META, id: input.id ?? "auth-system", title: input.title, body: input.body },
    }),
    deleteConcept: async () => ({ ok: true, deleted: true }),
    getConcept: async () => ({ concept: null }),
    list: async () => ({ count: 0, concepts: [] }),
    search: async () => ({ hits: [] }),
    related: async () => notFound("ghost"),
    graph: async () => ({ nodes: [], edges: [], types: [] }),
    listTypes: async () => ({ types: [] }),
    createType: async () => notFound("types unsupported in this fake"),
    updateType: async () => notFound("types unsupported in this fake"),
    deleteType: async () => ({ ok: true, deleted: false }),
    context: async (args) => ({
      markdown: `## Auth system (auth-system)\n\nBody for ${JSON.stringify(args.ids)}.`,
      included: [META],
      truncated: true,
      approxTokens: 29,
    }),
    stats: async () => ({
      concepts: 0,
      edges: 0,
      products: [],
      tags: [],
      byType: {},
      onboarded: true,
      openTasks: 0,
      embeddings: "unavailable",
      keywordIndex: "like",
    }),
    listTasks: async () => ({ count: 0, tasks: [] }),
    takeTask: async () => {
      throw new VaultDoError("no open tasks to take", 400);
    },
    completeTask: async () => notFound("ghost"),
    reopenTask: async () => notFound("ghost"),
    onboarding: async () => ({ onboardedAt: "2026-07-10T00:00:00.000Z" }),
    setOnboardedAt: async (at) => ({ ok: true, onboardedAt: at }),
    link: async ({ from, to, relation }) => ({ ok: true, from, to, relation: relation ?? "related_to" }),
    destroy: async () => ({ ok: true }),
  };
  return { ...base, ...overrides };
}

async function connect(vault: VaultClient): Promise<Client> {
  const server = buildMcpServer(vault);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function texts(result: Awaited<ReturnType<Client["callTool"]>>): string[] {
  return (result.content as { type: string; text: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text);
}

describe("link_concepts", () => {
  it("happy path parses with the contract outputSchema (default relation applied)", async () => {
    const client = await connect(vaultWith({}));
    const result = await client.callTool({ name: "link_concepts", arguments: { from: "a", to: "b" } });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(texts(result)[0]);
    expect(linkConceptsOutputSchema.safeParse(payload).success).toBe(true);
    expect(payload).toEqual({ ok: true, from: "a", to: "b", relation: "related_to" });
  });

  it("unknown source concept (DO 404) → isError result, not a protocol error", async () => {
    const client = await connect(
      vaultWith({
        link: async () => {
          throw new VaultDoError('no concept with id "nope"', 404);
        },
      }),
    );
    const result = await client.callTool({
      name: "link_concepts",
      arguments: { from: "nope", to: "b" },
    });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain('no concept with id "nope"');
  });
});

describe("get_related error paths", () => {
  it("unknown id (DO 404) → isError with the DO message", async () => {
    const client = await connect(vaultWith({}));
    const result = await client.callTool({ name: "get_related", arguments: { id: "ghost" } });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("ghost");
  });

  it("non-404 DO failures also become isError (guarded), never thrown", async () => {
    const client = await connect(
      vaultWith({
        related: async () => {
          throw new VaultDoError("vault storage unavailable", 500);
        },
      }),
    );
    const result = await client.callTool({ name: "get_related", arguments: { id: "x" } });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("vault storage unavailable");
  });
});

describe("DO failures on other tools stay inside the MCP boundary", () => {
  it("upsert_concept failure → isError", async () => {
    const client = await connect(
      vaultWith({
        upsertConcept: async () => {
          throw new VaultDoError("title must be a non-empty string", 400);
        },
      }),
    );
    const result = await client.callTool({
      name: "upsert_concept",
      arguments: { title: " ", body: "x" },
    });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("title");
  });

  it("vault_stats failure → isError", async () => {
    const client = await connect(
      vaultWith({
        stats: async () => {
          throw new Error("D1 exploded");
        },
      }),
    );
    const result = await client.callTool({ name: "vault_stats", arguments: {} });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("D1 exploded");
  });
});

describe("get_context passthrough", () => {
  it("explicit ids reach the vault and the footer mirrors the bundle's truncation/budget numbers", async () => {
    let seen: unknown;
    const client = await connect(
      vaultWith({
        context: async (args) => {
          seen = args;
          return {
            markdown: "## Auth system (auth-system)\n\nBody.",
            included: [META],
            truncated: true,
            approxTokens: 29,
          };
        },
      }),
    );
    const result = await client.callTool({
      name: "get_context",
      arguments: { ids: ["auth-system"], tokenBudget: 30, depth: 0 },
    });
    expect(result.isError ?? false).toBe(false);
    expect(seen).toMatchObject({ ids: ["auth-system"], tokenBudget: 30, depth: 0 });
    const blocks = texts(result);
    expect(blocks).toHaveLength(2);
    const footer = JSON.parse(blocks[1]);
    expect(getMcpTool("get_context").outputSchema.safeParse(footer).success).toBe(true);
    expect(footer).toEqual({ included: ["auth-system"], truncated: true, approxTokens: 29 });
  });

  it("empty ids array counts as missing (isError)", async () => {
    const client = await connect(vaultWith({}));
    const result = await client.callTool({ name: "get_context", arguments: { ids: [] } });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("query");
  });
});
