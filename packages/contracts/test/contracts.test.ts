import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CANONICAL_RELATIONS,
  claimInputSchema,
  claimOutputSchema,
  CLOUD_MCP_TOOLS,
  CLOUD_MCP_TOOL_NAMES,
  CONCEPT_TYPES,
  CONTRACTS_VERSION,
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  cliValidateJsonSchema,
  conceptMetaSchema,
  getContextOutputSchema,
  getMcpTool,
  graphResponseSchema,
  onboardCompleteOutputSchema,
  onboardInputSchema,
  onboardStatusOutputSchema,
  PUBLIC_MCP_TOOLS,
  PUBLIC_MCP_TOOL_NAMES,
  searchConceptsOutputSchema,
  signInInputSchema,
  signInOutputSchema,
  signupInputSchema,
  signupOutputSchema,
  toolConceptMetaSchema,
  upsertConceptInputSchema,
  vaultStatsOutputSchema,
} from "../src/index.js";

describe("CONTRACTS_VERSION", () => {
  it('is "11"', () => {
    // 11: public vaults — anonymous read-only via an unguessable, revocable
    //     token (publicStatusSchema, publicEnableResponseSchema) +
    //     PUBLIC_VAULT_READ_TOOL_NAMES (the viewer-scoped MCP read subset).
    // 10: onboarding at scale (onboard input gains optional areaList;
    //     status/complete output gain optional coverage report) + delete_concept
    //     MCP tool (remove a concept + its edges; idempotent no-op on missing id).
    // 8: Wave M — vault membership & email invites (role on vault shapes,
    //    member/invite schemas + endpoints).
    expect(CONTRACTS_VERSION).toBe("11");
  });
});

describe("MCP_TOOLS registry", () => {
  it("declares the spec'd tools, in registration order", () => {
    expect(MCP_TOOL_NAMES).toEqual([
      "search_concepts",
      "get_concept",
      "get_related",
      "get_context",
      "upsert_concept",
      "delete_concept",
      "link_concepts",
      "list_concepts",
      "vault_stats",
      "onboard",
      "list_tasks",
      "take_task",
      "complete_task",
      "create_task",
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
  it("declares exactly two tools: signup + sign_in", () => {
    expect(PUBLIC_MCP_TOOL_NAMES).toEqual(["signup", "sign_in"]);
    expect(PUBLIC_MCP_TOOLS).toHaveLength(2);
  });

  it("neither public tool is one of the 9 authenticated vault tools", () => {
    expect(MCP_TOOL_NAMES).not.toContain("signup");
    expect(MCP_TOOL_NAMES).not.toContain("sign_in");
  });

  it("signup carries a title, an orchestrator-facing description, and zod schemas", () => {
    const [signup] = PUBLIC_MCP_TOOLS;
    expect(signup.title.length).toBeGreaterThan(0);
    expect(signup.description.length).toBeGreaterThan(50);
    // The description must teach the guardrail model: anonymous signup, 7-day
    // unclaimed expiry, persistence via the claim tool, keep the key secret,
    // and NEVER any URL in the result.
    expect(signup.description).toMatch(/apiKey/i);
    expect(signup.description).toMatch(/7 days?/i);
    expect(signup.description).toMatch(/claim/);
    expect(signup.description).toMatch(/never log|never returned/i);
    expect(signup.description).toMatch(/no URL/i);
    expect(signup.description).not.toMatch(/loginUrl/);
    expect(signup.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(signup.outputSchema).toBeInstanceOf(z.ZodType);
  });

  it("signup input is fully optional (anonymous); email is validated when present", () => {
    expect(signupInputSchema.safeParse({}).success).toBe(true);
    expect(signupInputSchema.safeParse({ vaultName: "Acme brain" }).success).toBe(true);
    expect(signupInputSchema.safeParse({ email: "human@example.com" }).success).toBe(true);
    expect(
      signupInputSchema.safeParse({ email: "human@example.com", vaultName: "Acme brain" }).success,
    ).toBe(true);
    expect(signupInputSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(signupInputSchema.safeParse({ vaultName: "" }).success).toBe(false);
  });

  it("signup output round-trips, is strict, and carries NO URL or email fields", () => {
    const payload = {
      apiKey: "bz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultSlug: "my-vault",
      expiresAt: "2026-07-17T00:00:00.000Z",
      claimEmailSent: false,
    };
    const parsed = signupOutputSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(payload);
    // A URL of any kind in the output is a contract violation (strict shape).
    expect(signupOutputSchema.safeParse({ ...payload, loginUrl: "https://x" }).success).toBe(false);
    expect(signupOutputSchema.safeParse({ ...payload, claimUrl: "https://x" }).success).toBe(false);
    expect(signupOutputSchema.safeParse({ ...payload, email: "h@x.com" }).success).toBe(false);
  });

  it("sign_in requires a valid email and its description says the link is EMAILED, never returned", () => {
    const signIn = PUBLIC_MCP_TOOLS.find((t) => t.name === "sign_in")!;
    expect(signIn).toBeDefined();
    expect(signIn.title.length).toBeGreaterThan(0);
    expect(signIn.description.length).toBeGreaterThan(50);
    // Teaches the guardrail model: the link is emailed and never handed back.
    expect(signIn.description).toMatch(/EMAIL/i);
    expect(signIn.description).toMatch(/NEVER returned/i);
    expect(signIn.description).toMatch(/inbox/i);
    // A valid email is required; anything else is rejected.
    expect(signInInputSchema.safeParse({ email: "human@example.com" }).success).toBe(true);
    expect(signInInputSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(signInInputSchema.safeParse({}).success).toBe(false);
  });

  it("sign_in output is the generic strict {status:'sent'} — NO URL leaks", () => {
    expect(signInOutputSchema.safeParse({ status: "sent" }).success).toBe(true);
    // Strict shape: a login URL of any kind is a contract violation.
    expect(signInOutputSchema.safeParse({ status: "sent", loginUrl: "https://x" }).success).toBe(
      false,
    );
    expect(signInOutputSchema.safeParse({ status: "sent", url: "https://x" }).success).toBe(false);
    // The status is a fixed literal — no other value is valid.
    expect(signInOutputSchema.safeParse({ status: "queued" }).success).toBe(false);
  });
});

describe("CLOUD_MCP_TOOLS registry (cloud-only authenticated surface)", () => {
  it("declares exactly one tool: claim — never part of MCP_TOOLS", () => {
    expect(CLOUD_MCP_TOOL_NAMES).toEqual(["claim"]);
    expect(CLOUD_MCP_TOOLS).toHaveLength(1);
    expect(MCP_TOOL_NAMES).not.toContain("claim");
  });

  it("claim's description tells the agent the link is emailed, never returned", () => {
    const [claim] = CLOUD_MCP_TOOLS;
    expect(claim.title.length).toBeGreaterThan(0);
    expect(claim.description).toMatch(/email/i);
    expect(claim.description).toMatch(/NEVER returned/i);
    expect(claim.description).toMatch(/human/i);
    expect(claim.description).toMatch(/once/i);
  });

  it("claim input requires a valid email", () => {
    expect(claimInputSchema.safeParse({ email: "human@example.com" }).success).toBe(true);
    expect(claimInputSchema.safeParse({ email: "nope" }).success).toBe(false);
    expect(claimInputSchema.safeParse({}).success).toBe(false);
  });

  it("claim output is strict {status: 'sent', expiresAt} — no token, no URL", () => {
    const payload = { status: "sent", expiresAt: "2026-07-12T00:00:00.000Z" };
    expect(claimOutputSchema.safeParse(payload).success).toBe(true);
    expect(claimOutputSchema.safeParse({ ...payload, url: "https://x" }).success).toBe(false);
    expect(claimOutputSchema.safeParse({ ...payload, token: "t" }).success).toBe(false);
    expect(claimOutputSchema.safeParse({ status: "queued", expiresAt: payload.expiresAt }).success).toBe(false);
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

  it("vault_stats output uses the `embeddings` key and reports onboarded", () => {
    const parsed = vaultStatsOutputSchema.safeParse({
      concepts: 13,
      edges: 54,
      products: ["acme-crm"],
      tags: ["auth"],
      byType: { decision: 3 },
      onboarded: false,
      openTasks: 2,
      embeddings: "unavailable",
    });
    expect(parsed.success).toBe(true);
    // onboarded is part of the v3 shape — its absence is a contract violation.
    expect(
      vaultStatsOutputSchema.safeParse({
        concepts: 0,
        edges: 0,
        products: [],
        tags: [],
        byType: {},
        embeddings: "ready",
      }).success,
    ).toBe(false);
  });

  it("search_concepts allows the optional onboarding notice", () => {
    expect(
      searchConceptsOutputSchema.safeParse({ notice: "vault not onboarded", hits: [] }).success,
    ).toBe(true);
    expect(searchConceptsOutputSchema.safeParse({ hits: [] }).success).toBe(true);
  });
});

describe("product ontology (v3)", () => {
  it("has the 11 concept types, additive over the original 6", () => {
    expect(CONCEPT_TYPES).toHaveLength(11);
    for (const t of ["concept", "feature", "decision", "constraint", "pattern", "glossary"]) {
      expect(CONCEPT_TYPES).toContain(t);
    }
    for (const t of ["domain", "story", "spec", "workflow", "task"]) {
      expect(CONCEPT_TYPES).toContain(t);
    }
  });

  it("documents the canonical relations incl. realized_by, governs, and task relations", () => {
    expect(CANONICAL_RELATIONS).toContain("realized_by");
    expect(CANONICAL_RELATIONS).toContain("governs");
    expect(CANONICAL_RELATIONS).toContain("part_of");
    expect(CANONICAL_RELATIONS).toContain("realizes");
    expect(CANONICAL_RELATIONS).toContain("governed_by");
  });

  it("concept metas round-trip the optional task fields (strict otherwise)", () => {
    const meta = {
      id: "task-fix-auth",
      title: "Fix auth",
      type: "task",
      status: "active",
      tags: ["high"],
      taskStatus: "taken",
      takenBy: "fleet-1",
      takenAt: "2026-07-11T00:00:00.000Z",
      filePath: "/v/concepts/task-fix-auth.md",
    };
    const parsed = conceptMetaSchema.safeParse(meta);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.taskStatus).toBe("taken");
    expect(parsed.success && parsed.data.takenBy).toBe("fleet-1");
  });

  it("concept metas round-trip codeAreas (optional, strict otherwise)", () => {
    const meta = {
      id: "session-refresh",
      title: "Session Refresh",
      type: "feature",
      status: "active",
      tags: [],
      codeAreas: ["packages/auth/src/session.ts", "apps/web/src/hooks/**"],
      filePath: "/v/concepts/session-refresh.md",
    };
    const parsed = conceptMetaSchema.safeParse(meta);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.codeAreas).toEqual(meta.codeAreas);
    // Compact tool meta carries them too; omission stays valid.
    const { filePath: _fp, ...tool } = meta;
    expect(toolConceptMetaSchema.safeParse(tool).success).toBe(true);
    expect(toolConceptMetaSchema.safeParse({ ...tool, codeAreas: undefined }).success).toBe(true);
  });

  it("upsert_concept input accepts the new types and codeAreas", () => {
    const parsed = upsertConceptInputSchema.safeParse({
      title: "Billing domain",
      body: "…",
      type: "domain",
      codeAreas: ["apps/billing/**"],
      relations: { governs: ["invoicing"] },
    });
    expect(parsed.success).toBe(true);
    expect(
      upsertConceptInputSchema.safeParse({ title: "x", body: "", type: "banana" }).success,
    ).toBe(false);
  });
});

describe("onboard tool contract", () => {
  it("is the 9th tool with an agent-facing description", () => {
    const onboard = getMcpTool("onboard");
    expect(onboard.description).toMatch(/playbook/i);
    expect(onboard.description).toMatch(/upsert_concept/);
  });

  it("input takes start/complete/status actions", () => {
    expect(onboardInputSchema.safeParse({ action: "start", productName: "Acme" }).success).toBe(
      true,
    );
    expect(onboardInputSchema.safeParse({ action: "complete", summary: "done" }).success).toBe(
      true,
    );
    expect(onboardInputSchema.safeParse({ action: "status" }).success).toBe(true);
    expect(onboardInputSchema.safeParse({ action: "restart" }).success).toBe(false);
  });

  it("input accepts an optional areaList (status/complete continue loop)", () => {
    expect(
      onboardInputSchema.safeParse({ action: "status", areaList: ["packages/engine", "apps/cloud/src"] })
        .success,
    ).toBe(true);
    expect(
      onboardInputSchema.safeParse({ action: "complete", summary: "done", areaList: ["packages/engine"] })
        .success,
    ).toBe(true);
    // areaList must be strings.
    expect(onboardInputSchema.safeParse({ action: "status", areaList: [1, 2] }).success).toBe(false);
  });

  it("status/complete outputs round-trip an optional coverage report", () => {
    const coverage = { covered: ["packages/engine"], uncovered: ["apps/cloud/src"], coveragePct: 50 };
    expect(
      onboardStatusOutputSchema.safeParse({
        onboarded: false,
        conceptCount: 3,
        byType: { feature: 3 },
        coverage,
      }).success,
    ).toBe(true);
    expect(
      onboardCompleteOutputSchema.safeParse({
        ok: true,
        onboarded: true,
        summaryConceptId: "product-onboarding-summary",
        conceptCount: 3,
        conceptsLackingCodeAreas: 0,
        hasDomainConcepts: true,
        byType: { domain: 1, feature: 2 },
        coverage,
      }).success,
    ).toBe(true);
    // coverageNote (the no-areaList warning path) also validates.
    expect(
      onboardCompleteOutputSchema.safeParse({
        ok: true,
        onboarded: true,
        summaryConceptId: "product-onboarding-summary",
        conceptCount: 3,
        conceptsLackingCodeAreas: 0,
        hasDomainConcepts: true,
        byType: { domain: 1, feature: 2 },
        coverageNote: "no areaList supplied",
      }).success,
    ).toBe(true);
    // coverage is strict: unknown keys rejected.
    expect(
      onboardStatusOutputSchema.safeParse({
        onboarded: false,
        conceptCount: 0,
        byType: {},
        coverage: { covered: [], uncovered: [], coveragePct: 0, extra: true },
      }).success,
    ).toBe(false);
  });

  it("status/complete outputs are strict", () => {
    expect(
      onboardStatusOutputSchema.safeParse({
        onboarded: false,
        conceptCount: 3,
        byType: { domain: 1, feature: 2 },
      }).success,
    ).toBe(true);
    expect(
      onboardCompleteOutputSchema.safeParse({
        ok: true,
        onboarded: true,
        summaryConceptId: "product-onboarding-summary",
        conceptCount: 3,
        conceptsLackingCodeAreas: 1,
        hasDomainConcepts: true,
        byType: { domain: 1, feature: 2 },
      }).success,
    ).toBe(true);
    // Quality signals are required; the pre-signals shape no longer validates.
    expect(
      onboardCompleteOutputSchema.safeParse({
        ok: true,
        onboarded: true,
        summaryConceptId: "product-onboarding-summary",
      }).success,
    ).toBe(false);
    expect(
      onboardCompleteOutputSchema.safeParse({ ok: true, onboarded: false }).success,
    ).toBe(false);
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
