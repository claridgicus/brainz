/**
 * Registry integrity + wire-shape round-trips across the WHOLE contract
 * surface: every MCP tool (authed + public) has a unique name and schemas
 * that accept a realistic sample payload, and every REST/CLI schema
 * round-trips a sample of the shipped shape.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiConceptSchema,
  apiErrorSchema,
  apiKeyCreateRequestSchema,
  apiKeyCreateResponseSchema,
  apiKeyListResponseSchema,
  apiKeySchema,
  cliReindexJsonSchema,
  cliShowJsonSchema,
  conceptListResponseSchema,
  contextRequestSchema,
  contextResponseSchema,
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  PUBLIC_MCP_TOOLS,
  PUBLIC_MCP_TOOL_NAMES,
  relatedQuerySchema,
  searchQuerySchema,
  vaultCreateRequestSchema,
  vaultListResponseSchema,
  vaultSchema,
  vaultUpdateRequestSchema,
  type McpToolName,
  type PublicMcpToolName,
} from "../src/index.js";

// ------------------------------------------------------- registry integrity

/** A realistic, minimal INPUT sample for every tool (authed + public). */
const INPUT_SAMPLES: Record<McpToolName | PublicMcpToolName, unknown> = {
  search_concepts: { query: "lead scoring" },
  get_concept: { id: "lead-scoring" },
  get_related: { id: "lead-scoring", depth: 2 },
  get_context: { query: "auth", tokenBudget: 500 },
  upsert_concept: {
    title: "Billing domain",
    body: "Links [[invoicing]].",
    type: "domain",
    codeAreas: ["apps/billing/**"],
    relations: { governs: ["invoicing"] },
  },
  link_concepts: { from: "a", to: "b", relation: "depends_on" },
  list_concepts: { type: "spec" },
  vault_stats: {},
  onboard: { action: "start", productName: "Acme" },
  signup: { email: "human@example.com", vaultName: "Acme Brain" },
};

const META = {
  id: "lead-scoring",
  title: "Lead scoring",
  type: "feature",
  status: "active",
  tags: ["crm"],
} as const;

/** A realistic OUTPUT sample for every tool (get_context's is its JSON footer). */
const OUTPUT_SAMPLES: Record<McpToolName | PublicMcpToolName, unknown> = {
  search_concepts: { hits: [{ id: "a", title: "A", type: "feature", score: 1.2, snippet: "…" }] },
  get_concept: {
    ...META,
    filePath: "concepts/lead-scoring.md",
    body: "Scores leads.",
    neighbors: [{ ...META, id: "auth", title: "Auth", relation: "depends_on", direction: "out" }],
  },
  get_related: { id: "lead-scoring", related: [{ ...META, distance: 1, via: [{ from: "lead-scoring", to: "auth", relation: "depends_on" }] }] },
  get_context: { included: ["a", "b"], truncated: true, approxTokens: 480 },
  upsert_concept: { ...META, filePath: "concepts/lead-scoring.md" },
  link_concepts: { ok: true, from: "a", to: "b", relation: "depends_on" },
  list_concepts: { count: 1, concepts: [META] },
  vault_stats: {
    concepts: 4,
    edges: 5,
    products: ["crm"],
    tags: ["auth"],
    byType: { feature: 2 },
    onboarded: true,
    embeddings: "ready",
  },
  onboard: { onboarded: false, conceptCount: 4, byType: { feature: 2 } },
  signup: {
    apiKey: "bz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    loginUrl: "https://example.com/api/auth/magic-link/verify?token=" + "0".repeat(32),
    vaultSlug: "acme-brain",
    email: "human@example.com",
  },
};

describe("tool registry integrity (MCP_TOOLS + PUBLIC_MCP_TOOLS)", () => {
  const allTools = [...MCP_TOOLS, ...PUBLIC_MCP_TOOLS];

  it("names are unique across BOTH registries combined", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(MCP_TOOL_NAMES.length + PUBLIC_MCP_TOOL_NAMES.length);
  });

  it("every tool's inputSchema parses its sample payload", () => {
    for (const tool of allTools) {
      const sample = INPUT_SAMPLES[tool.name];
      const parsed = (tool.inputSchema as z.ZodTypeAny).safeParse(sample);
      expect(parsed.success, `${tool.name} input sample must parse`).toBe(true);
    }
  });

  it("every tool's inputSchema rejects a wrong-typed payload", () => {
    // vault_stats takes {} and (non-strict) tolerates junk keys; every other
    // tool must reject a payload whose required field has the wrong type.
    const bad: Partial<Record<McpToolName | PublicMcpToolName, unknown>> = {
      search_concepts: { query: 42 },
      get_concept: { id: 42 },
      get_related: { id: "x", depth: "deep" },
      get_context: { tokenBudget: "big" },
      upsert_concept: { title: "x", body: 42 },
      link_concepts: { from: "a" },
      list_concepts: { type: "banana" },
      onboard: { action: "restart" },
      signup: { email: "not-an-email" },
    };
    for (const tool of allTools) {
      const sample = bad[tool.name];
      if (sample === undefined) continue;
      const parsed = (tool.inputSchema as z.ZodTypeAny).safeParse(sample);
      expect(parsed.success, `${tool.name} must reject ${JSON.stringify(sample)}`).toBe(false);
    }
  });

  it("every tool's outputSchema parses its sample payload", () => {
    for (const tool of allTools) {
      const sample = OUTPUT_SAMPLES[tool.name];
      const parsed = (tool.outputSchema as z.ZodTypeAny).safeParse(sample);
      expect(parsed.success, `${tool.name} output sample must parse`).toBe(true);
    }
  });

  it("input schemas are plain-JSON safe (no transforms lost over the wire)", () => {
    for (const tool of allTools) {
      const sample = INPUT_SAMPLES[tool.name];
      const parsed = (tool.inputSchema as z.ZodTypeAny).parse(JSON.parse(JSON.stringify(sample)));
      // Round-tripping the parsed value through JSON must be lossless.
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    }
  });
});

// -------------------------------------------------------- REST wire shapes

describe("REST schemas round-trip the shipped shapes", () => {
  it("vault + vault list", () => {
    const vault = { id: "v1", slug: "my-vault", name: "My vault", createdAt: "2026-07-10T00:00:00.000Z" };
    expect(vaultSchema.parse(vault)).toEqual(vault);
    expect(vaultListResponseSchema.parse({ vaults: [vault] })).toEqual({ vaults: [vault] });
  });

  it("vault create/update requests validate name and optional slug", () => {
    expect(vaultCreateRequestSchema.safeParse({ name: "Acme" }).success).toBe(true);
    expect(vaultCreateRequestSchema.safeParse({ name: "Acme", slug: "acme" }).success).toBe(true);
    expect(vaultCreateRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(vaultCreateRequestSchema.safeParse({}).success).toBe(false);
    expect(vaultUpdateRequestSchema.safeParse({}).success).toBe(true); // PATCH: all optional
    expect(vaultUpdateRequestSchema.safeParse({ slug: "" }).success).toBe(false);
  });

  it("api key shapes: plaintext only on create, never in the list", () => {
    const key = {
      id: "k1",
      vaultId: "v1",
      name: "ci-key",
      keyPrefix: "bz_a1B2c…",
      createdAt: "2026-07-10T00:00:00.000Z",
      lastUsedAt: null,
    };
    expect(apiKeySchema.parse(key)).toEqual(key);
    expect(apiKeyCreateResponseSchema.safeParse({ ...key, key: "bz_x".padEnd(35, "0") }).success).toBe(true);
    expect(apiKeyCreateResponseSchema.safeParse(key).success).toBe(false); // create MUST carry key
    expect(apiKeyListResponseSchema.safeParse({ keys: [key] }).success).toBe(true);
    expect(apiKeyCreateRequestSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("search query params coerce numeric strings and enforce bounds", () => {
    const parsed = searchQuerySchema.parse({ q: "auth", limit: "5" });
    expect(parsed).toMatchObject({ q: "auth", mode: "hybrid", limit: 5 });
    expect(searchQuerySchema.safeParse({ q: "" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "x", limit: "51" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "x", mode: "psychic" }).success).toBe(false);
    // The search type filter accepts the full 10-type ontology.
    expect(searchQuerySchema.safeParse({ q: "x", type: "domain" }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ q: "x", type: "workflow" }).success).toBe(true);
  });

  it("related query params coerce depth and cap it at 3", () => {
    expect(relatedQuerySchema.parse({})).toEqual({ depth: 1 });
    expect(relatedQuerySchema.parse({ depth: "3", limit: "2" })).toEqual({ depth: 3, limit: 2 });
    expect(relatedQuerySchema.safeParse({ depth: "4" }).success).toBe(false);
    expect(relatedQuerySchema.safeParse({ depth: "0" }).success).toBe(false);
  });

  it("context request applies tool defaults; response is strict", () => {
    expect(contextRequestSchema.parse({ query: "auth" })).toMatchObject({ depth: 1, tokenBudget: 4000 });
    const bundle = {
      markdown: "## A (a)\n\nBody.",
      included: [{ id: "a", title: "A", type: "concept", status: "active", tags: [] }],
      truncated: false,
      approxTokens: 5,
    };
    expect(contextResponseSchema.parse(bundle)).toEqual(bundle);
    expect(contextResponseSchema.safeParse({ ...bundle, extra: 1 }).success).toBe(false);
  });

  it("apiConcept (GET .../concepts/:id) carries timestamps + body, never neighbors", () => {
    const wire = {
      id: "a",
      title: "A",
      type: "spec" as const,
      status: "active" as const,
      tags: [],
      codeAreas: ["src/**"],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      body: "Body.",
    };
    expect(apiConceptSchema.parse(wire)).toEqual(wire);
    expect(apiConceptSchema.safeParse({ ...wire, neighbors: [] }).success).toBe(false);
  });

  it("concept list response reuses the list_concepts tool shape", () => {
    const payload = { count: 1, concepts: [META] };
    expect(conceptListResponseSchema.parse(payload)).toEqual(payload);
  });

  it("error envelope is { error }", () => {
    expect(apiErrorSchema.parse({ error: "vault not found" })).toEqual({ error: "vault not found" });
    expect(apiErrorSchema.safeParse({ message: "x" }).success).toBe(false);
  });
});

describe("CLI --json schemas round-trip", () => {
  const fullMeta = {
    id: "a",
    title: "A",
    type: "decision" as const,
    status: "active" as const,
    tags: ["x"],
    filePath: "/vault/concepts/a.md",
  };

  it("show: full concept + edge-level neighbors (pending → title null)", () => {
    const payload = {
      ...fullMeta,
      body: "Body.",
      neighbors: [
        { direction: "out", relation: "depends_on", id: "b", title: "B" },
        { direction: "out", relation: "related_to", id: "ghost", title: null },
      ],
    };
    expect(cliShowJsonSchema.parse(payload)).toEqual(payload);
  });

  it("reindex: VaultStats + embeddingStatus", () => {
    const payload = {
      concepts: 13,
      edges: 54,
      products: ["acme-crm"],
      tags: ["auth"],
      byType: { decision: 3 },
      onboarded: false,
      embeddingStatus: "unavailable",
    };
    expect(cliReindexJsonSchema.parse(payload)).toEqual(payload);
    expect(cliReindexJsonSchema.safeParse({ ...payload, embeddingStatus: "maybe" }).success).toBe(false);
  });
});
