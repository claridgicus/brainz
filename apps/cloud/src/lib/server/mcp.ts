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
  PUBLIC_VAULT_READ_TOOL_NAMES,
  type CloudMcpToolDef,
  type McpToolDef,
  type McpToolInput,
  type McpToolName,
} from "@brainz/contracts";
import {
  ONBOARDING_NUDGE,
  ONBOARDING_SUMMARY_ID,
  SYNC_STALENESS_NUDGE,
  computeCoverage,
  isSyncStale,
  onboardingPlaybook,
  sessionHookPlaybook,
  sessionInstructions,
  syncPlaybook,
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
   * Called when a sync point is recorded — at `onboard {complete}` (the initial
   * baseline) and every `sync {complete}` — to mirror last_synced_at into the D1
   * control-plane column. Failures must not fail the tool call; the DO meta is
   * the tool-facing source of truth.
   */
  onSynced?: (lastSyncedAt: Date) => Promise<void>;
  /**
   * Cloud-only tools registered ALONGSIDE the vault tools (e.g. `claim` from
   * CLOUD_MCP_TOOLS — account concerns that only exist on Brainz Cloud). The
   * route supplies the wired handlers; the local stdio server never sees
   * these. Handlers must follow the isError convention (use `guarded`).
   */
  extraTools?: readonly ExtraTool[];
  /**
   * Restrict the registered vault tools to this allow-list (public vaults):
   * a VIEWER-scoped public-token connection gets ONLY the read tools
   * (PUBLIC_VAULT_READ_TOOL_NAMES). When set, WRITE tools are never registered,
   * so they cannot be invoked at all — the viewer role is enforced by absence,
   * not a runtime check. `extraTools` are also skipped (no claim on the public
   * surface). Omit for the full authenticated (editor-equivalent) surface.
   */
  only?: readonly McpToolName[];
}

/** Build the MCP server for one vault (stateless: one per request). */
export function buildMcpServer(vault: VaultClient, hooks: McpServerHooks = {}): McpServer {
  // `instructions` ride the initialize response, so every client that surfaces
  // them starts each session already told to reach for Brainz by default. A
  // viewer-scoped connection gets the read-only variant (no write-back advice).
  const server = new McpServer(
    {
      name: hooks.only ? `${SERVER_NAME}-public-read` : SERVER_NAME,
      version: SERVER_VERSION,
    },
    { instructions: sessionInstructions({ readOnly: hooks.only !== undefined }) },
  );

  const isOnboarded = async (): Promise<boolean> =>
    (await vault.onboarding()).onboardedAt !== null;

  /**
   * The one-line nudge to prefix on search/context results, or null for none.
   * Onboarding takes precedence (you can't be stale before onboarding); an
   * onboarded-but-stale vault (last sync older than the threshold) gets the
   * sync nudge instead. A nudge, not a wall — the two never stack.
   */
  const nudgeNotice = async (): Promise<string | null> => {
    const [{ onboardedAt }, { lastSyncedAt }] = await Promise.all([
      vault.onboarding(),
      vault.syncState(),
    ]);
    if (onboardedAt === null) return ONBOARDING_NUDGE;
    // Fall back to onboardedAt as the baseline if last_synced_at was never set
    // (a vault onboarded before sync shipped) so staleness is measured from a
    // real point, not treated as "never synced".
    if (isSyncStale(true, lastSyncedAt ?? onboardedAt)) return SYNC_STALENESS_NUDGE;
    return null;
  };

  const handlers: ToolHandlers = {
    search_concepts: async ({ query, mode, product, tags, type, limit }) =>
      guarded(async () => {
        const [{ hits }, notice] = await Promise.all([
          vault.search({ query, mode, product, tags, type, limit }),
          nudgeNotice(),
        ]);
        // Nudge, not a wall: un-onboarded → onboarding nudge; stale → sync nudge.
        return ok({ ...(notice ? { notice } : {}), hits });
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
        const [bundle, notice] = await Promise.all([
          vault.context({ query, ids, product, depth, tokenBudget }),
          nudgeNotice(),
        ]);
        // Two-block convention (GET_CONTEXT_CONTENT_BLOCKS in @brainz/contracts):
        // markdown briefing first, then the JSON footer. Un-onboarded vaults get
        // the onboarding nudge; onboarded-but-stale vaults get the sync nudge
        // (never both) atop the markdown.
        const markdown =
          notice && bundle.markdown ? `${notice}\n\n${bundle.markdown}` : bundle.markdown;
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

    delete_concept: async ({ id }) =>
      guarded(async () => {
        // Idempotent: the DO returns deleted:false for a missing id (no throw),
        // so a repeat/typo delete is a clean no-op success, not an error.
        const { deleted } = await vault.deleteConcept(id);
        return ok({ deleted, id });
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
        const { concepts, edges, products, tags, byType, onboarded, openTasks, embeddings, lastDreamAt } =
          await vault.stats();
        // keywordIndex is intentionally dropped: vault_stats' contract shape is strict.
        return ok({
          concepts,
          edges,
          products,
          tags,
          byType,
          onboarded,
          openTasks,
          embeddings,
          ...(lastDreamAt !== undefined ? { lastDreamAt } : {}),
        });
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
          // Onboarding IS the initial sync point — stamp last_synced_at now so
          // the staleness clock starts here, not from "never synced".
          await vault.setLastSyncedAt(onboardedAt.toISOString());
          // Mirror both into the D1 control plane; never fail the tool call on it.
          await hooks.onOnboarded?.(onboardedAt).catch(() => {});
          await hooks.onSynced?.(onboardedAt).catch(() => {});
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

    sync: async ({ action, productName, summary, areaList, changedPaths }) =>
      guarded(async () => {
        if (action === "start") {
          // Sync start hands out the DRIFT playbook (diff since last sync →
          // update stale → index new), scoped to change — NOT the full onboard
          // playbook. It embeds a coverage map when an areaList is supplied.
          const [{ onboardedAt }, { lastSyncedAt }, { concepts }] = await Promise.all([
            vault.onboarding(),
            vault.syncState(),
            vault.list(),
          ]);
          const playbook = syncPlaybook({
            productName,
            onboarded: onboardedAt !== null,
            lastSyncedAt: lastSyncedAt ?? onboardedAt,
            areaList,
            concepts,
            changedPaths,
          });
          return { content: [{ type: "text", text: playbook }] };
        }
        if (action === "complete") {
          if (!summary?.trim()) {
            return fail('sync {action: "complete"} requires a non-empty `summary`');
          }
          const [{ concepts: conceptCount, byType }, { concepts }] = await Promise.all([
            vault.stats(),
            vault.list(),
          ]);
          // Guard the same "sealed but empty" dead state as onboard complete.
          if (conceptCount === 0) {
            return fail(
              "cannot complete sync: the vault has no concepts — onboard the product first",
            );
          }
          const conceptsLackingCodeAreas = concepts.filter(
            (c) => !c.codeAreas || c.codeAreas.length === 0,
          ).length;
          // Coverage-gate the seal exactly like onboard complete: with an
          // areaList, refuse if the graph went too thin (drift left gaps).
          let coverage: ReturnType<typeof computeCoverage> | undefined;
          let coverageNote: string | undefined;
          if (areaList && areaList.length > 0) {
            coverage = computeCoverage(concepts, areaList);
            const uncoveredFraction = coverage.uncovered.length / (areaList.length || 1);
            if (uncoveredFraction > THIN_COVERAGE_UNCOVERED_FRACTION) {
              return fail(
                "sync looks incomplete — these areas have no concepts yet: " +
                  `${coverage.uncovered.join(", ")} (${coverage.coveragePct}% covered). ` +
                  "Keep indexing each uncovered area, then complete.",
              );
            }
          } else {
            coverageNote =
              "no areaList supplied — coverage was not verified; " +
              "pass the repo's source areas to have completion coverage-gated.";
          }
          // Append (never overwrite) this sync note to the running sync log on
          // the product-onboarding-summary concept.
          const lastSyncedAt = new Date();
          const stamp = lastSyncedAt.toISOString();
          const { concept: existing } = await vault.getConcept(ONBOARDING_SUMMARY_ID);
          const prior = existing?.body?.trimEnd();
          const note = `## Sync ${stamp}\n\n${summary.trim()}`;
          const body = prior ? `${prior}\n\n${note}\n` : `${note}\n`;
          const { concept } = await vault.upsertConcept({
            id: ONBOARDING_SUMMARY_ID,
            title: "Product onboarding summary",
            type: "spec",
            body,
          });
          await vault.setLastSyncedAt(stamp);
          // Mirror into the D1 control plane; never fail the tool call on it.
          await hooks.onSynced?.(lastSyncedAt).catch(() => {});
          return ok({
            ok: true,
            lastSyncedAt: stamp,
            summaryConceptId: concept.id,
            conceptCount,
            conceptsLackingCodeAreas,
            byType,
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
        // status — onboarded state, last sync, staleness, counts, + coverage.
        const [{ concepts: conceptCount, byType, onboarded }, { onboardedAt }, { lastSyncedAt }] =
          await Promise.all([vault.stats(), vault.onboarding(), vault.syncState()]);
        const baseline = lastSyncedAt ?? onboardedAt;
        const stale = isSyncStale(onboarded, baseline);
        let coverage: { covered: string[]; uncovered: string[]; coveragePct: number } | undefined;
        if (areaList && areaList.length > 0) {
          const { concepts } = await vault.list();
          const c = computeCoverage(concepts, areaList);
          coverage = { covered: c.covered, uncovered: c.uncovered, coveragePct: c.coveragePct };
        }
        return ok({
          onboarded,
          lastSyncedAt: baseline,
          stale,
          conceptCount,
          byType,
          ...(coverage ? { coverage } : {}),
        });
      }),

    // Session-hook convention (SESSION_HOOK_CONTENT in @brainz/contracts): ONE
    // markdown text block — the playbook the calling agent applies to its own
    // harness. Stateless: Brainz can't write to the caller's repo.
    session_hook: async ({ client, serverName }) =>
      guarded(async () => ({
        content: [{ type: "text", text: sessionHookPlaybook({ client, serverName }) }],
      })),

    // Dreaming: the VaultDO runs the sweep (alarm-driven nightly, or now via
    // "run"); the tool only routes the action.
    dream: async ({ action, id, limit, enabled, cadenceHours }) =>
      guarded(async () => {
        if (action === "run") return ok(await vault.dreamRun());
        if (action === "diary") return ok(await vault.dreamDiary(limit ?? 10));
        if (action === "revert") {
          if (!id) return fail('dream {action: "revert"} requires the dream `id`');
          return ok(await vault.dreamRevert(id));
        }
        if (action === "configure") return ok(await vault.dreamConfigure({ enabled, cadenceHours }));
        return ok(await vault.dreamStatus());
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

  // Public (viewer) connections register ONLY the read allow-list; the write
  // tools never enter the server, so viewer scope is enforced by absence.
  const allow = hooks.only ? new Set<McpToolName>(hooks.only) : null;
  for (const tool of MCP_TOOLS as readonly McpToolDef[]) {
    if (allow && !allow.has(tool.name)) continue;
    const handler = handlers[tool.name] as (args: Record<string, unknown>) => Promise<ToolResult>;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: Record<string, unknown>) => handler(args),
    );
  }

  // Cloud-only extras (e.g. the `claim` tool) — never part of MCP_TOOLS, and
  // never exposed to a viewer-scoped public connection.
  for (const extra of allow ? [] : (hooks.extraTools ?? [])) {
    server.registerTool(
      extra.def.name,
      {
        title: extra.def.title,
        description: extra.def.description,
        inputSchema: extra.def.inputSchema.shape,
        annotations: { title: extra.def.title, ...extra.def.annotations },
      },
      async (args: Record<string, unknown>) => extra.handler(args ?? {}),
    );
  }

  return server;
}

/**
 * Build the VIEWER-scoped MCP server for a public-vault token (public vaults):
 * the READ tools only (PUBLIC_VAULT_READ_TOOL_NAMES) over the vault's DO. No
 * write tools, no onboard, no task mutations, no claim — they are never
 * registered, so a public token literally cannot invoke them. Stateless: one
 * per request, exactly like buildMcpServer.
 */
export function buildPublicVaultMcpServer(vault: VaultClient): McpServer {
  return buildMcpServer(vault, { only: PUBLIC_VAULT_READ_TOOL_NAMES });
}
