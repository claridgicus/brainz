/**
 * Remote MCP server over a vault's Durable Object.
 *
 * Tool names/descriptions/schemas come from MCP_TOOLS in @brainz/contracts —
 * the same registry @brainz/mcp-server (stdio) iterates; only the handlers
 * differ (they call the VaultDO instead of a local Vault). Same handler-map
 * pattern, same wire shapes (tests parse responses with the contract
 * outputSchema).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MCP_TOOLS,
  type CloudMcpToolDef,
  type McpToolDef,
  type McpToolInput,
  type McpToolName,
} from "@brainz/contracts";
import {
  ONBOARDING_NUDGE,
  ONBOARDING_SUMMARY_ID,
  computeCoverage,
  onboardingPlaybook,
} from "@brainz/engine";
import { syntheticFilePath } from "./do-helpers";
import { VaultDoError, type VaultClient } from "./vault-client";

export const SERVER_NAME = "brainz-cloud";
export const SERVER_VERSION = "0.1.0";

/**
 * Coverage gate for `onboard {action:"complete"}`: reject completion when more
 * than this fraction of the caller's reported source areas have zero concepts.
 * At >40% uncovered the graph is too thin to seal — keep indexing first.
 */
export const THIN_COVERAGE_UNCOVERED_FRACTION = 0.4;

type TextContent = { type: "text"; text: string };
export type ToolResult = { content: TextContent[]; isError?: boolean };

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Never throw across the MCP boundary — errors become isError results. */
export async function guarded(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

type ToolHandlers = {
  [N in McpToolName]: (args: McpToolInput<N>) => Promise<ToolResult>;
};

/** A cloud-only tool registration: contract def (CLOUD_MCP_TOOLS) + handler. */
export interface ExtraTool {
  readonly def: CloudMcpToolDef;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface McpServerHooks {
  /**
   * Called when `onboard {action: "complete"}` succeeds — mirrors the DO's
   * onboarded state into the D1 control plane (vault.onboarded_at). Failures
   * must not fail the tool call; the DO meta is the tool-facing source of truth.
   */
  onOnboarded?: (onboardedAt: Date) => Promise<void>;
  /**
   * Cloud-only tools registered ALONGSIDE the vault tools (e.g. `claim` from
   * CLOUD_MCP_TOOLS — account concerns that only exist on Brainz Cloud). The
   * route supplies the wired handlers; the local stdio server never sees
   * these. Handlers must follow the isError convention (use `guarded`).
   */
  extraTools?: readonly ExtraTool[];
}

/** Build the MCP server for one vault (stateless: one per request). */
export function buildMcpServer(vault: VaultClient, hooks: McpServerHooks = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const isOnboarded = async (): Promise<boolean> =>
    (await vault.onboarding()).onboardedAt !== null;

  const handlers: ToolHandlers = {
    search_concepts: async ({ query, mode, product, tags, type, limit }) =>
      guarded(async () => {
        const [{ hits }, onboarded] = await Promise.all([
          vault.search({ query, mode, product, tags, type, limit }),
          isOnboarded(),
        ]);
        // Nudge, not a wall: un-onboarded vaults carry the onboarding notice.
        return ok({ ...(onboarded ? {} : { notice: ONBOARDING_NUDGE }), hits });
      }),

    get_concept: async ({ id }) =>
      guarded(async () => {
        const { concept } = await vault.getConcept(id);
        if (!concept) {
          return fail(
            `no concept with id "${id}" — use search_concepts or list_concepts to find valid ids`,
          );
        }
        const { neighbors, body, createdAt, updatedAt, ...meta } = concept;
        return ok({
          ...meta,
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          filePath: syntheticFilePath(concept.id),
          body,
          neighbors,
        });
      }),

    get_related: async ({ id, depth, limit, relations }) =>
      guarded(async () => {
        try {
          const result = await vault.related({ id, depth, limit, relations });
          return ok(result);
        } catch (err) {
          if (err instanceof VaultDoError && err.status === 404) return fail(err.message);
          throw err;
        }
      }),

    get_context: async ({ query, ids, product, depth, tokenBudget }) =>
      guarded(async () => {
        if (!query && (!ids || ids.length === 0)) {
          return fail("get_context requires at least one of `query` or `ids`");
        }
        const [bundle, onboarded] = await Promise.all([
          vault.context({ query, ids, product, depth, tokenBudget }),
          isOnboarded(),
        ]);
        // Two-block convention (GET_CONTEXT_CONTENT_BLOCKS in @brainz/contracts):
        // markdown briefing first, then the JSON footer. Un-onboarded vaults
        // get the one-line onboarding nudge atop the markdown.
        const markdown =
          !onboarded && bundle.markdown
            ? `${ONBOARDING_NUDGE}\n\n${bundle.markdown}`
            : bundle.markdown;
        const footer = JSON.stringify({
          included: bundle.included.map((c) => c.id),
          truncated: bundle.truncated,
          approxTokens: bundle.approxTokens,
        });
        return {
          content: [
            { type: "text", text: markdown },
            { type: "text", text: footer },
          ],
        };
      }),

    upsert_concept: async ({
      id,
      title,
      body,
      type,
      status,
      product,
      tags,
      codeAreas,
      taskStatus,
      takenBy,
      takenAt,
      doneAt,
      relations,
    }) =>
      guarded(async () => {
        const { concept } = await vault.upsertConcept({
          id,
          title,
          body,
          type,
          status,
          product,
          tags,
          codeAreas,
          taskStatus,
          takenBy,
          takenAt,
          doneAt,
          relations,
        });
        return ok({
          id: concept.id,
          title: concept.title,
          type: concept.type,
          status: concept.status,
          ...(concept.product !== undefined ? { product: concept.product } : {}),
          tags: concept.tags,
          ...(concept.codeAreas !== undefined ? { codeAreas: concept.codeAreas } : {}),
          ...(concept.taskStatus !== undefined ? { taskStatus: concept.taskStatus } : {}),
          ...(concept.takenBy !== undefined ? { takenBy: concept.takenBy } : {}),
          ...(concept.takenAt !== undefined ? { takenAt: concept.takenAt } : {}),
          ...(concept.doneAt !== undefined ? { doneAt: concept.doneAt } : {}),
          filePath: syntheticFilePath(concept.id),
        });
      }),

    link_concepts: async ({ from, to, relation }) =>
      guarded(async () => {
        try {
          const result = await vault.link({ from, to, relation });
          return ok(result);
        } catch (err) {
          if (err instanceof VaultDoError && err.status === 404) return fail(err.message);
          throw err;
        }
      }),

    list_concepts: async ({ product, type, tag }) =>
      guarded(async () => {
        const result = await vault.list({ product, type, tag });
        return ok(result);
      }),

    vault_stats: async () =>
      guarded(async () => {
        const { concepts, edges, products, tags, byType, onboarded, openTasks, embeddings } =
          await vault.stats();
        // keywordIndex is intentionally dropped: vault_stats' contract shape is strict.
        return ok({ concepts, edges, products, tags, byType, onboarded, openTasks, embeddings });
      }),

    onboard: async ({ action, productName, repoHint, summary, areaList }) =>
      guarded(async () => {
        if (action === "start") {
          const { onboardedAt } = await vault.onboarding();
          // Idempotent start: an already-onboarded vault must NOT get a fresh
          // playbook — re-running the indexing playbook risks blindly
          // duplicating concepts. Return a guard notice pointing at the update
          // paths instead (SPEC-CLOUD.md: "onboarding once per project").
          if (onboardedAt !== null) {
            const parsed = new Date(onboardedAt);
            const date = Number.isNaN(parsed.getTime())
              ? onboardedAt
              : parsed.toISOString().slice(0, 10);
            return fail(
              `already onboarded on ${date} — re-running start risks duplicate concepts; ` +
                "use list_concepts/upsert_concept to update, or the task tools",
            );
          }
          // Onboard-start convention (ONBOARD_START_CONTENT in @brainz/contracts):
          // one markdown text block — the playbook itself.
          const playbook = onboardingPlaybook({
            productName,
            repoHint,
            onboarded: false,
          });
          return { content: [{ type: "text", text: playbook }] };
        }
        if (action === "complete") {
          if (!summary?.trim()) {
            return fail('onboard {action: "complete"} requires a non-empty `summary`');
          }
          // Guard against the "onboarded but empty" dead state: completing over
          // an empty graph would permanently silence the nudge with nothing
          // indexed. Refuse, and surface quality signals on success so callers
          // can judge whether the graph is actually worth sealing.
          const [{ concepts: conceptCount, byType }, { concepts }] = await Promise.all([
            vault.stats(),
            vault.list(),
          ]);
          if (conceptCount === 0) {
            return fail(
              "cannot complete onboarding: the vault has no concepts — index the product first",
            );
          }
          const conceptsLackingCodeAreas = concepts.filter(
            (c) => !c.codeAreas || c.codeAreas.length === 0,
          ).length;
          const hasDomainConcepts = (byType.domain ?? 0) > 0;
          // Coverage gate: if the caller reported its source areas, refuse to
          // seal a thin graph (too many areas with zero concepts). Without an
          // areaList we can't judge — warn instead of hard-blocking (empty
          // vault is already guarded above).
          let coverage: ReturnType<typeof computeCoverage> | undefined;
          let coverageNote: string | undefined;
          if (areaList && areaList.length > 0) {
            coverage = computeCoverage(concepts, areaList);
            const uncoveredFraction = coverage.uncovered.length / (areaList.length || 1);
            if (uncoveredFraction > THIN_COVERAGE_UNCOVERED_FRACTION) {
              return fail(
                "onboarding looks incomplete — these areas have no concepts yet: " +
                  `${coverage.uncovered.join(", ")} (${coverage.coveragePct}% covered). ` +
                  "Keep indexing each uncovered area, then complete.",
              );
            }
          } else {
            coverageNote =
              "no areaList supplied — coverage was not verified; " +
              "pass the repo's source areas to have completion coverage-gated.";
          }
          const { concept } = await vault.upsertConcept({
            id: ONBOARDING_SUMMARY_ID,
            title: "Product onboarding summary",
            type: "spec",
            body: summary.trim(),
          });
          const onboardedAt = new Date();
          await vault.setOnboardedAt(onboardedAt.toISOString());
          // Mirror into the D1 control plane; never fail the tool call on it.
          await hooks.onOnboarded?.(onboardedAt).catch(() => {});
          return ok({
            ok: true,
            onboarded: true,
            summaryConceptId: concept.id,
            conceptCount,
            conceptsLackingCodeAreas,
            hasDomainConcepts,
            byType,
            // Report only the wire coverage fields (drop the helper's internal
            // conceptCount — the top-level conceptCount already carries it).
            ...(coverage
              ? {
                  coverage: {
                    covered: coverage.covered,
                    uncovered: coverage.uncovered,
                    coveragePct: coverage.coveragePct,
                  },
                }
              : {}),
            ...(coverageNote ? { coverageNote } : {}),
          });
        }
        // status — counts, plus a coverage report when an areaList is supplied.
        const { concepts: conceptCount, byType, onboarded } = await vault.stats();
        if (areaList && areaList.length > 0) {
          const { concepts } = await vault.list();
          const { covered, uncovered, coveragePct } = computeCoverage(concepts, areaList);
          return ok({
            onboarded,
            conceptCount,
            byType,
            coverage: { covered, uncovered, coveragePct },
          });
        }
        return ok({ onboarded, conceptCount, byType });
      }),

    list_tasks: async ({ taskStatus, domain }) =>
      guarded(async () => {
        const result = await vault.listTasks({ taskStatus, domain });
        return ok(result);
      }),

    take_task: async ({ id, takenBy }) =>
      guarded(async () => {
        try {
          const result = await vault.takeTask({ id, takenBy });
          return ok(result);
        } catch (err) {
          if (err instanceof VaultDoError) return fail(err.message);
          throw err;
        }
      }),

    complete_task: async ({ id, outcome }) =>
      guarded(async () => {
        try {
          const result = await vault.completeTask({ id, outcome });
          return ok(result);
        } catch (err) {
          if (err instanceof VaultDoError) return fail(err.message);
          throw err;
        }
      }),

    create_task: async ({ title, body, domain, realizes, governedBy, codeAreas, tags }) =>
      guarded(async () => {
        const relations: Record<string, string[]> = {};
        if (domain) relations.part_of = [domain];
        if (realizes && realizes.length > 0) relations.realizes = realizes;
        if (governedBy && governedBy.length > 0) relations.governed_by = governedBy;
        const { concept } = await vault.upsertConcept({
          title,
          body,
          type: "task",
          taskStatus: "open",
          tags,
          codeAreas,
          relations: Object.keys(relations).length > 0 ? relations : undefined,
        });
        return ok({
          id: concept.id,
          title: concept.title,
          type: concept.type,
          status: concept.status,
          ...(concept.product !== undefined ? { product: concept.product } : {}),
          tags: concept.tags,
          ...(concept.codeAreas !== undefined ? { codeAreas: concept.codeAreas } : {}),
          ...(concept.taskStatus !== undefined ? { taskStatus: concept.taskStatus } : {}),
          ...(concept.createdAt !== undefined ? { createdAt: concept.createdAt } : {}),
          ...(concept.updatedAt !== undefined ? { updatedAt: concept.updatedAt } : {}),
          filePath: syntheticFilePath(concept.id),
        });
      }),
  };

  for (const tool of MCP_TOOLS as readonly McpToolDef[]) {
    const handler = handlers[tool.name] as (args: Record<string, unknown>) => Promise<ToolResult>;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
      },
      async (args: Record<string, unknown>) => handler(args),
    );
  }

  // Cloud-only extras (e.g. the `claim` tool) — never part of MCP_TOOLS.
  for (const extra of hooks.extraTools ?? []) {
    server.registerTool(
      extra.def.name,
      {
        title: extra.def.title,
        description: extra.def.description,
        inputSchema: extra.def.inputSchema.shape,
      },
      async (args: Record<string, unknown>) => extra.handler(args ?? {}),
    );
  }

  return server;
}
