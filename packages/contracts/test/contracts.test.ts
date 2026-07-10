import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONTRACTS_VERSION,
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  cliValidateJsonSchema,
  getContextOutputSchema,
  getMcpTool,
  graphResponseSchema,
  PUBLIC_MCP_TOOLS,
  PUBLIC_MCP_TOOL_NAMES,
  searchConceptsOutputSchema,
  signupInputSchema,
  signupOutputSchema,
  vaultStatsOutputSchema,
} from "../src/index.js";

describe("CONTRACTS_VERSION", () => {
  it('is "2"', () => {
    expect(CONTRACTS_VERSION).toBe("2");
  });
});

describe("MCP_TOOLS registry", () => {
  it("declares the eight spec'd tools, in registration order", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "search_concepts",
      "get_concept",
      "get_related",
      "get_context",
      "upsert_concept",
      "link_concepts",
      "list_concepts",
      "vault_stats",
    ]);
  });

  it("every tool carries a title, a non-empty description, and zod schemas", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(50);
      expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
      expect(tool.outputSchema).toBeInstanceOf(z.ZodType);
    }
  });

  it("getMcpTool returns the registry entry and throws on unknown names", () => {
    expect(getMcpTool("search_concepts").title).toBe("Search concepts");
    expect(() => getMcpTool("nope" as never)).toThrow(/unknown MCP tool/);
  });

  it("input schemas apply the documented defaults", () => {
    const search = getMcpTool("search_concepts").inputSchema.parse({ query: "auth" });
    expect(search).toMatchObject({ query: "auth", mode: "hybrid", limit: 10 });
    const context = getMcpTool("get_context").inputSchema.parse({ ids: ["mrr"] });
    expect(context).toMatchObject({ depth: 1, tokenBudget: 4000 });
    const link = getMcpTool("link_concepts").inputSchema.parse({ from: "a", to: "b" });
    expect(link.relation).toBe("related_to");
  });
});

describe("PUBLIC_MCP_TOOLS registry (unauthenticated /mcp surface)", () => {
  it("declares exactly one tool: signup", () => {
    expect(PUBLIC_MCP_TOOL_NAMES).toEqual(["signup"]);
    expect(PUBLIC_MCP_TOOLS).toHaveLength(1);
  });

  it("signup is NOT one of the 8 authenticated vault tools", () => {
    expect(MCP_TOOL_NAMES).not.toContain("signup");
  });

  it("signup carries a title, an orchestrator-facing description, and zod schemas", () => {
    const [signup] = PUBLIC_MCP_TOOLS;
    expect(signup.title.length).toBeGreaterThan(0);
    expect(signup.description.length).toBeGreaterThan(50);
    // The description must tell the agent what to do with each credential.
    expect(signup.description).toMatch(/claimUrl/);
    expect(signup.description).toMatch(/apiKey/i);
    expect(signup.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(signup.outputSchema).toBeInstanceOf(z.ZodType);
  });

  it("signup input requires a valid email; vaultName is optional", () => {
    expect(signupInputSchema.safeParse({ email: "human@example.com" }).success).toBe(true);
    expect(
      signupInputSchema.safeParse({ email: "human@example.com", vaultName: "Acme brain" }).success,
    ).toBe(true);
    expect(signupInputSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(signupInputSchema.safeParse({}).success).toBe(false);
  });

  it("signup output round-trips and is strict", () => {
    const payload = {
      apiKey: "bz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      claimUrl: "https://brain.brownmatter.ai/claim/abc123",
      vaultSlug: "my-vault",
      email: "human@example.com",
    };
    const parsed = signupOutputSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(payload);
    expect(signupOutputSchema.safeParse({ ...payload, claimToken: "leak" }).success).toBe(false);
  });
});

describe("output schemas encode the shipped shapes", () => {
  it("search_concepts hits are compact (no filePath) and strict", () => {
    const ok = searchConceptsOutputSchema.safeParse({
      hits: [{ id: "a", title: "A", type: "feature", score: 1.5, snippet: "…" }],
    });
    expect(ok.success).toBe(true);
    const extra = searchConceptsOutputSchema.safeParse({
      hits: [{ id: "a", title: "A", type: "feature", score: 1, snippet: "", filePath: "/x" }],
    });
    expect(extra.success).toBe(false);
  });

  it("get_context's outputSchema is the JSON footer of the two-block response", () => {
    expect(
      getContextOutputSchema.safeParse({ included: ["a", "b"], truncated: false, approxTokens: 120 })
        .success,
    ).toBe(true);
    expect(getContextOutputSchema.safeParse({ included: ["a"] }).success).toBe(false);
  });

  it("vault_stats output uses the `embeddings` key", () => {
    const parsed = vaultStatsOutputSchema.safeParse({
      concepts: 13,
      edges: 54,
      products: ["acme-crm"],
      tags: ["auth"],
      byType: { decision: 3 },
      embeddings: "unavailable",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("graph payload matches packages/web's /api/graph shape", () => {
  it("accepts concept and pending nodes", () => {
    const parsed = graphResponseSchema.safeParse({
      nodes: [
        { id: "auth-system", title: "Auth System", type: "concept", product: "acme-crm", tags: ["auth"], degree: 3 },
        { id: "csv-parser", title: "csv-parser", type: "pending", tags: [], degree: 1, pending: true },
      ],
      edges: [{ from: "auth-system", to: "csv-parser", relation: "related_to" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects pending: false (shipped shape omits the key instead)", () => {
    const parsed = graphResponseSchema.safeParse({
      nodes: [{ id: "x", title: "x", type: "pending", tags: [], degree: 0, pending: false }],
      edges: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("cli --json schemas", () => {
  it("validate report round-trips", () => {
    const parsed = cliValidateJsonSchema.safeParse({
      ok: true,
      errors: [],
      warnings: [{ message: "broken link: a —related_to→ b (no such concept; treated as pending)" }],
      concepts: 13,
      edges: 54,
    });
    expect(parsed.success).toBe(true);
  });
});
