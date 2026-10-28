/**
 * Sync / re-onboard — the product's voice for keeping the graph true to the
 * artifact as code changes.
 *
 * Onboarding is one-shot: it indexes a product ONCE. After that the graph rots
 * whenever the codebase moves. `sync` is the supported re-index path: it hands
 * the calling agent a DRIFT playbook (diff since last sync → update stale
 * concepts → index new work → report coverage gaps) and records the sync point.
 *
 * Like the onboarding playbook, the text is single-sourced HERE so both MCP
 * servers (local stdio + Brainz Cloud) and the CLI speak with one voice. Sync
 * REUSES `computeCoverage` from onboard.ts for the coverage map — coverage
 * logic lives in exactly one place.
 */
import { computeCoverage, type Coverage, type CoverageConcept } from "./onboard.js";

/**
 * Staleness threshold: a vault whose `last_synced_at` is older than this many
 * days gets a one-line nudge on get_context / search results to run `sync`.
 * A nudge, not a wall — nothing is blocked. Named so tests and callers agree.
 */
export const SYNC_STALENESS_DAYS = 14;

/** SYNC_STALENESS_DAYS in milliseconds — the raw age threshold. */
export const SYNC_STALENESS_MS = SYNC_STALENESS_DAYS * 24 * 60 * 60 * 1000;

/**
 * One-line notice prefixed to search_concepts / get_context results when the
 * vault was last synced more than {@link SYNC_STALENESS_DAYS} days ago. A
 * nudge, not a wall — mirrors ONBOARDING_NUDGE. Composed AFTER the onboarding
 * nudge: an un-onboarded vault shows the onboarding nudge instead (that takes
 * precedence — you can't be stale before you've onboarded).
 */
export const SYNC_STALENESS_NUDGE =
  `Note: this vault hasn't been synced in over ${SYNC_STALENESS_DAYS} days — its knowledge graph may have drifted from the code. ` +
  'Call the sync tool with {"action": "start"} to re-index changed areas.';

/**
 * The neutral form of {@link SYNC_STALENESS_NUDGE} for directory surfaces: the
 * same fact with no instruction to call `sync` (see ONBOARDING_NOTICE).
 */
export const SYNC_STALENESS_NOTICE =
  `Note: this vault hasn't been synced in over ${SYNC_STALENESS_DAYS} days, so its knowledge graph may have drifted from the code.`;

/**
 * True when a vault is "stale": onboarded but its last sync is older than the
 * staleness threshold. `onboarded` must be true (an un-onboarded vault is
 * handled by the onboarding nudge, which takes precedence). `lastSyncedAt` is
 * the ISO timestamp of the last sync (or onboarding, the initial sync point);
 * a missing/unparseable value counts as stale for an onboarded vault so the
 * nudge is never silently swallowed.
 *
 * @param now injectable clock (ms since epoch) — tests pass a fixed value.
 */
export function isSyncStale(
  onboarded: boolean,
  lastSyncedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!onboarded) return false;
  if (!lastSyncedAt) return true;
  const t = Date.parse(lastSyncedAt);
  if (Number.isNaN(t)) return true;
  return now - t > SYNC_STALENESS_MS;
}

export interface SyncPlaybookOptions {
  /** Product name, echoed into the playbook heading. */
  productName?: string;
  /** ISO timestamp of the last sync (or initial onboarding). Null → never synced. */
  lastSyncedAt?: string | null;
  /** Whether the vault has been onboarded (sync only makes sense afterwards). */
  onboarded?: boolean;
  /**
   * The repo's top-level source areas (each package dir, each app src subtree,
   * major dirs), supplied by the AGENT's repo walk. When present, the playbook
   * embeds a COVERAGE MAP computed over the vault's concepts' code_areas.
   */
  areaList?: readonly string[];
  /** The vault's concepts (only their code_areas are read) for the coverage map. */
  concepts?: readonly CoverageConcept[];
  /**
   * Paths the agent found CHANGED since last_synced_at (from its own git
   * diff/log). When present, the playbook focuses the fan-out on these.
   */
  changedPaths?: readonly string[];
}

/** Render the coverage map section (or a nudge to supply an areaList). */
function coverageSection(coverage: Coverage | undefined): string {
  if (!coverage) {
    return "_No `areaList` supplied — pass the repo's top-level source areas to get a coverage map (covered vs uncovered areas) and have `complete` coverage-gated._";
  }
  const covered = coverage.covered.length > 0 ? coverage.covered.join(", ") : "(none)";
  const uncovered = coverage.uncovered.length > 0 ? coverage.uncovered.join(", ") : "(none)";
  return [
    `- **Coverage:** ${coverage.coveragePct}% (${coverage.covered.length}/${coverage.covered.length + coverage.uncovered.length} areas) over ${coverage.conceptCount} concepts.`,
    `- **Covered areas:** ${covered}`,
    `- **Uncovered areas (coverage gaps — no concept references them):** ${uncovered}`,
  ].join("\n");
}

/** Render the changed-paths section (or a nudge to run the diff). */
function changedSection(changedPaths: readonly string[] | undefined): string {
  if (changedPaths && changedPaths.length > 0) {
    const list = changedPaths.map((p) => `  - \`${p}\``).join("\n");
    return `You supplied these CHANGED paths — focus the fan-out on the areas they fall under:\n${list}`;
  }
  return "_No `changedPaths` supplied yet — run the git diff in step 1 and pass them back (or fan out over the areas you find changed)._";
}

/**
 * The SYNC playbook (markdown) returned by `sync {action: "start"}`:
 * instructions for the calling orchestrator to RE-INDEX only what drifted —
 * diff the codebase since last sync, update stale concepts whose code changed,
 * index new/un-mapped work, and report coverage gaps. It is deliberately NOT
 * the full onboarding playbook: sync is scoped to CHANGE, not a full re-survey.
 */
export function syncPlaybook(opts: SyncPlaybookOptions = {}): string {
  const product = opts.productName?.trim();
  const heading = product ? `# Sync playbook — ${product}` : "# Sync playbook";
  const since = opts.lastSyncedAt?.trim()
    ? `\`${opts.lastSyncedAt.trim()}\``
    : "(never synced — this is the first sync since onboarding)";
  const onboardedWarning = opts.onboarded
    ? ""
    : "\n> This vault is NOT onboarded yet. `sync` keeps an already-indexed graph true to the code — run `onboard` first to index the product, then come back to sync.\n";

  const coverage =
    opts.areaList && opts.areaList.length > 0
      ? computeCoverage(opts.concepts ?? [], opts.areaList)
      : undefined;

  return `${heading}
${onboardedWarning}
You are keeping the knowledge graph TRUE to the artifact. Since the initial onboard, the code has moved and the graph has drifted. Your job is NOT to re-onboard from scratch — it is to re-index only what CHANGED. Work the steps below, writing concepts back with \`upsert_concept\` as you go, and finish by calling \`sync\` with \`{"action": "complete", "summary": "..."}\`.

## Vault state

- **Last synced:** ${since}
- **Onboarded:** ${opts.onboarded ? "yes" : "no"}

## Coverage map

${coverageSection(coverage)}

## 1. Diff the codebase since the last sync

Brainz can't read your repo, so YOU run git and supply the changes. Diff since \`last_synced_at\` above:

- \`git log --since="<last_synced_at>" --name-only --pretty=format:\` — every file touched since the last sync.
- \`git diff --name-only <commit-at-last-sync>..HEAD\` — the net set of changed paths.
- Also fold in \`git status --porcelain\` for uncommitted work.
- Collapse the touched files into the top-level source areas they fall under, then pass them back as \`changedPaths\` (and your full \`areaList\`) so this playbook can focus and re-compute coverage.

${changedSection(opts.changedPaths)}

## 2. Fan out over the CHANGED areas only

Fan out subagents in parallel — one per changed area — to re-examine ONLY the areas the diff touched. Do NOT re-survey the whole tree; unchanged areas are already indexed. Each subagent reports the product behavior that changed, not a file-by-file tour.

## 3. Update stale concepts whose code_areas changed

For each changed area, find the concepts whose \`code_areas\` point into it (\`list_concepts\` / \`search_concepts\`, then \`get_concept\`). Where the code no longer matches the concept, UPDATE the concept in place with \`upsert_concept\` (same id) — refresh the body, relations, and code_areas. Do NOT create a duplicate; sync updates, it does not fork.

## 4. Index new / un-mapped work as new concepts

Where the diff added behavior no concept covers yet, INDEX it as new concepts (domains/features/stories/specs/workflows/decisions), each anchored with \`codeAreas\`, linked into the existing graph with typed relations. For incomplete work you find (a half-built feature, a gap, a follow-up), FILE a task with \`create_task\` so it lands on the board.

## 5. Report coverage gaps

Call \`sync\` with \`{"action": "status", "areaList": [<your area list>]}\` to see the refreshed coverage map: areas with ZERO concepts are gaps. Index each gap until coverage is broad again — same coverage signal onboarding uses, now measuring drift.

## 6. Complete the sync

When the changed areas are re-indexed and coverage holds, call \`sync\` with \`{"action": "complete", "summary": "<2–5 sentences: what changed, what you updated, what you indexed, remaining gaps>", "areaList": [<your area list>]}\`. Completion stamps \`last_synced_at = now\` (the new drift baseline) and APPENDS your summary to the \`product-onboarding-summary\` concept (a running sync log — it is never overwritten). Like onboard, complete can be coverage-gated: if too many areas went uncovered it is rejected — keep indexing, then complete.
`;
}
