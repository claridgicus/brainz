import * as path from "node:path";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MCP_TOOLS,
  type McpToolDef,
  type McpToolInput,
  type McpToolName,
} from "@brainz/contracts";
import {
  ONBOARDING_NUDGE,
  SYNC_STALENESS_NUDGE,
  computeCoverage,
  isSyncStale,
  onboardingPlaybook,
  sessionHookPlaybook,
  sessionInstructions,
  syncPlaybook,
  TASK_COMPLETE_REMINDER,
  type ConceptMeta,
  type DreamLlm,
  type Vault,
} from "@brainz/core";

export const SERVER_NAME = "brainz";
export const SERVER_VERSION = "0.1.0";

/**
 * Coverage gate for `onboard {action:"complete"}`: reject completion when more
 * than this fraction of the caller's reported source areas have zero concepts
 * (mirrors apps/cloud's onboard tool).
 */
export const THIN_COVERAGE_UNCOVERED_FRACTION = 0.4;

/**
 * Resolve the vault directory from CLI args / environment:
 * `--vault <dir>` (or `--vault=<dir>`), else `BRAINZ_VAULT`, else cwd.
 */
export function resolveVaultDir(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vault") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--vault requires a directory argument");
      }
      return path.resolve(value);
    }
    if (arg.startsWith("--vault=")) {
      const value = arg.slice("--vault=".length);
      if (!value) throw new Error("--vault requires a directory argument");
      return path.resolve(value);
    }
  }
  if (env.BRAINZ_VAULT) return path.resolve(env.BRAINZ_VAULT);
  return process.cwd();
}

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Run a tool handler; any thrown error becomes an isError result instead of crossing the MCP boundary. */
async function guarded(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Compact meta for tool output: drop absolute filePath noise, keep what an agent needs. */
function compactMeta(c: ConceptMeta) {
  return {
    id: c.id,
    title: c.title,
    type: c.type,
    status: c.status,
    ...(c.product !== undefined ? { product: c.product } : {}),
    tags: c.tags,
    ...(c.codeAreas !== undefined ? { codeAreas: c.codeAreas } : {}),
    ...(c.taskStatus !== undefined ? { taskStatus: c.taskStatus } : {}),
    ...(c.takenBy !== undefined ? { takenBy: c.takenBy } : {}),
    ...(c.takenAt !== undefined ? { takenAt: c.takenAt } : {}),
    ...(c.doneAt !== undefined ? { doneAt: c.doneAt } : {}),
  };
}

/** One handler per registry tool; args arrive already parsed against the contract inputSchema. */
type ToolHandlers = {
  [N in McpToolName]: (args: McpToolInput<N>) => Promise<ToolResult>;
};

/**
 * Build the Brainz MCP server over an already-opened Vault.
 * The caller owns the vault lifecycle (open/close) and the transport.
 *
 * Tool names, descriptions, and input schemas come from `MCP_TOOLS` in
 * `@brainz/contracts` — nothing wire-visible is declared here. Only the
 * handlers (and the resource template) live in this server.
 */
export interface CreateServerOptions {
  /**
   * LLM provider for the dream tool's REM phase. The stdio server ships none
   * yet, so a local `dream run` does light only (REM/deep skipped, diary
   * written); tests and embedders can inject one.
   */
  dreamLlm?: DreamLlm | null;
}

export function createServer(vault: Vault, options: CreateServerOptions = {}): McpServer {
  const dreamLlm = options.dreamLlm ?? null;
  // `instructions` ride the initialize response, so every client that surfaces
  // them starts each session already told to reach for Brainz by default.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: sessionInstructions() },
  );

  // ------------------------------------------------------------ tool handlers

  /**
   * The one-line nudge to prefix on search/context results, or null for none.
   * Onboarding takes precedence; an onboarded-but-stale vault (last sync older
   * than the threshold) gets the sync nudge instead. The two never stack.
   */
  const nudgeNotice = (): string | null => {
    if (vault.onboardedAt === null) return ONBOARDING_NUDGE;
    // Fall back to onboardedAt when last_synced_at was never set (onboarded
    // before sync shipped) so staleness measures from a real point.
    if (isSyncStale(true, vault.lastSyncedAt ?? vault.onboardedAt)) return SYNC_STALENESS_NUDGE;
    return null;
  };

  const handlers: ToolHandlers = {
    search_concepts: async ({ query, mode, product, tags, type, limit }) =>
      guarded(async () => {
        const hits = await vault.search({ query, mode, product, tags, type, limit });
        const notice = nudgeNotice();
        return ok({
          // Nudge, not a wall: un-onboarded → onboarding nudge; stale → sync nudge.
          ...(notice ? { notice } : {}),
          hits: hits.map((h) => ({
            id: h.concept.id,
            title: h.concept.title,
            type: h.concept.type,
            score: h.score,
            snippet: h.snippet,
          })),
        });
      }),

    get_concept: async ({ id }) =>
      guarded(() => {
        const concept = vault.getConcept(id);
        if (!concept) {
          return fail(
            `no concept with id "${id}" — use search_concepts or list_concepts to find valid ids`,
          );
        }
        const neighbors = vault.related(id, { depth: 1 }).map((node) => {
          const edge = node.via[node.via.length - 1];
          return {
            ...compactMeta(node.concept),
            relation: edge?.relation ?? "related_to",
            direction: edge ? (edge.from === id ? "out" : "in") : "out",
          };
        });
        return ok({
          ...compactMeta(concept),
          ...(concept.createdAt !== undefined ? { createdAt: concept.createdAt } : {}),
          ...(concept.updatedAt !== undefined ? { updatedAt: concept.updatedAt } : {}),
          filePath: concept.filePath,
          body: concept.body,
          neighbors,
        });
      }),

    get_related: async ({ id, depth, limit, relations }) =>
      guarded(() => {
        if (!vault.getConcept(id)) {
          return fail(
            `no concept with id "${id}" — use search_concepts or list_concepts to find valid ids`,
          );
        }
        const nodes = vault.related(id, { depth, limit, relations });
        return ok({
          id,
          related: nodes.map((node) => ({
            ...compactMeta(node.concept),
            distance: node.distance,
            via: node.via.map((e) => ({ from: e.from, to: e.to, relation: e.relation })),
          })),
        });
      }),

    get_context: async ({ query, ids, product, depth, tokenBudget }) =>
      guarded(async () => {
        if (!query && (!ids || ids.length === 0)) {
          return fail("get_context requires at least one of `query` or `ids`");
        }
        const bundle = await vault.assembleContext({ query, ids, product, depth, tokenBudget });
        // Two-block convention (see GET_CONTEXT_CONTENT_BLOCKS in @brainz/contracts):
        // markdown briefing first, then the JSON footer that matches the outputSchema.
        // Un-onboarded vaults get the onboarding nudge; onboarded-but-stale vaults
        // get the sync nudge (never both) atop the markdown.
        const notice = nudgeNotice();
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
        const saved = await vault.upsertConcept({
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
        return ok({ ...compactMeta(saved), filePath: saved.filePath });
      }),

    delete_concept: async ({ id }) =>
      guarded(async () => {
        // Idempotent: deleting a missing id is a no-op success (deleted:false).
        const { deleted } = await vault.deleteConcept(id);
        return ok({ deleted, id });
      }),

    link_concepts: async ({ from, to, relation }) =>
      guarded(async () => {
        await vault.link(from, to, relation);
        return ok({ ok: true, from, to, relation });
      }),

    list_concepts: async ({ product, type, tag }) =>
      guarded(() => {
        const concepts = vault.listConcepts({ product, type, tag });
        return ok({ count: concepts.length, concepts: concepts.map(compactMeta) });
      }),

    vault_stats: async () =>
      guarded(() => {
        const stats = vault.stats();
        return ok({ ...stats, embeddings: vault.embeddingStatus, lastDreamAt: vault.lastDreamAt });
      }),

    onboard: async ({ action, productName, repoHint, summary, areaList }) =>
      guarded(async () => {
        if (action === "start") {
          // Idempotent start: an already-onboarded vault must NOT get a fresh
          // playbook — re-running the indexing playbook risks blindly
          // duplicating concepts. Return a guard notice pointing at the update
          // paths instead (SPEC-CLOUD.md: "onboarding once per project").
          if (vault.onboardedAt != null) {
            const parsed = new Date(vault.onboardedAt);
            const date = Number.isNaN(parsed.getTime())
              ? vault.onboardedAt
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
          // Guard against the "onboarded but empty" dead state, and surface
          // quality signals on success (mirrors apps/cloud's onboard tool).
          const stats = vault.stats();
          if (stats.concepts === 0) {
            return fail(
              "cannot complete onboarding: the vault has no concepts — index the product first",
            );
          }
          const concepts = vault.listConcepts();
          const conceptsLackingCodeAreas = concepts.filter(
            (c) => !c.codeAreas || c.codeAreas.length === 0,
          ).length;
          // Coverage gate: refuse to seal a thin graph when the caller reported
          // its source areas; warn (don't block) when it can't be judged.
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
          const saved = await vault.completeOnboarding(summary);
          return ok({
            ok: true,
            onboarded: true,
            summaryConceptId: saved.id,
            conceptCount: stats.concepts,
            conceptsLackingCodeAreas,
            hasDomainConcepts: (stats.byType.domain ?? 0) > 0,
            byType: stats.byType,
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
        const stats = vault.stats();
        if (areaList && areaList.length > 0) {
          const { covered, uncovered, coveragePct } = computeCoverage(
            vault.listConcepts(),
            areaList,
          );
          return ok({
            onboarded: stats.onboarded,
            conceptCount: stats.concepts,
            byType: stats.byType,
            coverage: { covered, uncovered, coveragePct },
          });
        }
        return ok({
          onboarded: stats.onboarded,
          conceptCount: stats.concepts,
          byType: stats.byType,
        });
      }),

    sync: async ({ action, productName, summary, areaList, changedPaths }) =>
      guarded(async () => {
        if (action === "start") {
          // Drift playbook (diff since last sync → update stale → index new),
          // scoped to change — NOT the full onboard playbook.
          const playbook = syncPlaybook({
            productName,
            onboarded: vault.onboardedAt !== null,
            lastSyncedAt: vault.lastSyncedAt ?? vault.onboardedAt,
            areaList,
            concepts: vault.listConcepts(),
            changedPaths,
          });
          return { content: [{ type: "text", text: playbook }] };
        }
        if (action === "complete") {
          if (!summary?.trim()) {
            return fail('sync {action: "complete"} requires a non-empty `summary`');
          }
          const stats = vault.stats();
          if (stats.concepts === 0) {
            return fail(
              "cannot complete sync: the vault has no concepts — onboard the product first",
            );
          }
          const concepts = vault.listConcepts();
          const conceptsLackingCodeAreas = concepts.filter(
            (c) => !c.codeAreas || c.codeAreas.length === 0,
          ).length;
          // Coverage-gate the seal exactly like onboard complete.
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
          // Append to the running sync log + stamp the new drift baseline.
          const saved = await vault.completeSync(summary);
          return ok({
            ok: true,
            lastSyncedAt: vault.lastSyncedAt ?? new Date().toISOString(),
            summaryConceptId: saved.id,
            conceptCount: stats.concepts,
            conceptsLackingCodeAreas,
            byType: stats.byType,
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
        const stats = vault.stats();
        const baseline = vault.lastSyncedAt ?? vault.onboardedAt;
        const stale = isSyncStale(stats.onboarded, baseline);
        if (areaList && areaList.length > 0) {
          const { covered, uncovered, coveragePct } = computeCoverage(
            vault.listConcepts(),
            areaList,
          );
          return ok({
            onboarded: stats.onboarded,
            lastSyncedAt: baseline,
            stale,
            conceptCount: stats.concepts,
            byType: stats.byType,
            coverage: { covered, uncovered, coveragePct },
          });
        }
        return ok({
          onboarded: stats.onboarded,
          lastSyncedAt: baseline,
          stale,
          conceptCount: stats.concepts,
          byType: stats.byType,
        });
      }),

    // Session-hook convention (SESSION_HOOK_CONTENT in @brainz/contracts): ONE
    // markdown text block — the playbook the calling agent applies to its own
    // harness. Stateless: Brainz can't write to the caller's repo.
    session_hook: async ({ client, serverName }) =>
      guarded(async () => ({
        content: [{ type: "text", text: sessionHookPlaybook({ client, serverName }) }],
      })),

    dream: async ({ action, id, limit, enabled, cadenceHours }) =>
      guarded(async () => {
        const status = async () => {
          const [lastEntry] = await vault.dreamDiary(1);
          return {
            ...vault.dreamConfig(),
            lastDreamAt: vault.lastDreamAt,
            // Local vaults have no scheduler: dreams run on demand only.
            nextDreamAt: null,
            inFlight: null,
            llm: dreamLlm?.name ?? null,
            ...(lastEntry ? { lastEntry } : {}),
          };
        };
        if (action === "run") return ok(await vault.dream({ llm: dreamLlm, trigger: "manual" }));
        if (action === "diary") {
          const entries = await vault.dreamDiary(limit ?? 10);
          return ok({ count: entries.length, entries });
        }
        if (action === "revert") {
          if (!id) return fail('dream {action: "revert"} requires the dream `id`');
          return ok(await vault.revertDream(id));
        }
        if (action === "configure") await vault.configureDreaming({ enabled, cadenceHours });
        return ok(await status());
      }),

    list_tasks: async ({ taskStatus, domain }) =>
      guarded(() => {
        const edges = vault.edges();
        const domainOf = (id: string): string[] =>
          edges.filter((e) => e.from === id && e.relation === "part_of").map((e) => e.to);
        const tasks = vault
          .listConcepts({ type: "task" })
          .filter((m) => {
            const status = m.taskStatus ?? "open";
            if (taskStatus && status !== taskStatus) return false;
            if (domain && !domainOf(m.id).includes(domain)) return false;
            return true;
          })
          .sort(
            (a, b) =>
              (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
          );
        return ok({ count: tasks.length, tasks: tasks.map(compactMeta) });
      }),

    take_task: async ({ id, takenBy }) =>
      guarded(async () => {
        let target: ConceptMeta | undefined;
        if (id) {
          const concept = vault.getConcept(id);
          if (!concept) return fail(`no task with id "${id}"`);
          if (concept.type !== "task") return fail(`concept "${id}" is not a task`);
          const status = concept.taskStatus ?? "open";
          if (status !== "open") {
            return fail(
              `task "${id}" is already ${status}` +
                (concept.takenBy ? ` (by ${concept.takenBy})` : ""),
            );
          }
          target = concept;
        } else {
          const open = vault
            .listConcepts({ type: "task" })
            .filter((m) => (m.taskStatus ?? "open") === "open")
            .sort(
              (a, b) =>
                (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
            );
          if (open.length === 0) return fail("no open tasks to take");
          target = open[0];
        }

        const takenAt = new Date().toISOString();
        const saved = await vault.upsertConcept({
          id: target.id,
          title: target.title,
          body: vault.getConcept(target.id)?.body ?? "",
          type: "task",
          taskStatus: "taken",
          takenBy: takenBy?.trim() || "an agent",
          takenAt,
        });

        // Briefing: the task + its part_of domain + realizes / governed_by targets.
        const seedIds = [saved.id];
        const edges = vault.edges();
        for (const rel of ["part_of", "realizes", "governed_by"]) {
          for (const e of edges) if (e.from === saved.id && e.relation === rel) seedIds.push(e.to);
        }
        const bundle = await vault.assembleContext({ ids: seedIds, depth: 1, tokenBudget: 4000 });
        return ok({
          task: {
            ...compactMeta(saved),
            ...(saved.createdAt !== undefined ? { createdAt: saved.createdAt } : {}),
            ...(saved.updatedAt !== undefined ? { updatedAt: saved.updatedAt } : {}),
          },
          body: vault.getConcept(saved.id)?.body ?? "",
          context: {
            markdown: bundle.markdown,
            included: bundle.included.map((c) => c.id),
            truncated: bundle.truncated,
            approxTokens: bundle.approxTokens,
          },
        });
      }),

    complete_task: async ({ id, outcome }) =>
      guarded(async () => {
        const concept = vault.getConcept(id);
        if (!concept) return fail(`no task with id "${id}"`);
        if (concept.type !== "task") return fail(`concept "${id}" is not a task`);
        if (!outcome?.trim()) return fail("complete_task requires a non-empty `outcome`");
        const doneAt = new Date().toISOString();
        const base = concept.body.endsWith("\n")
          ? concept.body.replace(/\n+$/, "\n")
          : `${concept.body}\n`;
        const saved = await vault.upsertConcept({
          id: concept.id,
          title: concept.title,
          body: `${base}\n## Outcome\n\n${outcome.trim()}\n`,
          type: "task",
          taskStatus: "done",
          doneAt,
        });
        return ok({
          task: {
            ...compactMeta(saved),
            ...(saved.createdAt !== undefined ? { createdAt: saved.createdAt } : {}),
            ...(saved.updatedAt !== undefined ? { updatedAt: saved.updatedAt } : {}),
          },
          reminder: TASK_COMPLETE_REMINDER,
        });
      }),

    create_task: async ({ title, body, domain, realizes, governedBy, codeAreas, tags }) =>
      guarded(async () => {
        const relations: Record<string, string[]> = {};
        if (domain) relations.part_of = [domain];
        if (realizes && realizes.length > 0) relations.realizes = realizes;
        if (governedBy && governedBy.length > 0) relations.governed_by = governedBy;
        const saved = await vault.upsertConcept({
          title,
          body,
          type: "task",
          taskStatus: "open",
          tags,
          codeAreas,
          relations: Object.keys(relations).length > 0 ? relations : undefined,
        });
        return ok({
          ...compactMeta(saved),
          ...(saved.createdAt !== undefined ? { createdAt: saved.createdAt } : {}),
          ...(saved.updatedAt !== undefined ? { updatedAt: saved.updatedAt } : {}),
          filePath: saved.filePath,
        });
      }),
  };

  // ------------------------------------------------- registrations (from contracts)

  for (const tool of MCP_TOOLS as readonly McpToolDef[]) {
    // The handlers map ties each tool name to its contract input type; at this
    // generic iteration site TS cannot correlate the union members, so widen once.
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

  // ------------------------------------------------------------ resources

  server.registerResource(
    "concept",
    new ResourceTemplate("brainz://concept/{id}", {
      list: async () => ({
        resources: vault.listConcepts().map((c) => ({
          uri: `brainz://concept/${c.id}`,
          name: c.title,
          description: `${c.type} — ${c.id}`,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Vault concept",
      description: "Markdown source of a concept note in the Brainz vault.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const id = String(variables.id ?? "");
      const concept = vault.getConcept(id);
      if (!concept) throw new Error(`no concept with id "${id}"`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# ${concept.title}\n\n${concept.body}`,
          },
        ],
      };
    },
  );

  return server;
}
