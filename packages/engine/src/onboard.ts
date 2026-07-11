/**
 * Onboarding — the product's voice to orchestrator agents.
 *
 * Brainz does not run agents itself: the `onboard` tool hands the CALLING
 * agent this playbook and tracks completion. Both MCP servers (local stdio
 * and Brainz Cloud) and the CLI render the exact same text from here, so the
 * product speaks with one voice everywhere.
 */

/** Id of the spec-type concept that stores the onboarding summary. */
export const ONBOARDING_SUMMARY_ID = "product-onboarding-summary";

/**
 * One-line notice prefixed to search_concepts / get_context results while a
 * vault is un-onboarded. A nudge, not a wall — nothing is blocked.
 */
export const ONBOARDING_NUDGE =
  'Note: this vault is not onboarded yet — call the onboard tool with {"action": "start"} to index your product into it first.';

export interface OnboardingPlaybookOptions {
  /** Product name, echoed into the playbook heading. */
  productName?: string;
  /** Where the codebase lives (path or URL), echoed into step 1. */
  repoHint?: string;
  /** Whether the vault is already onboarded (re-run tailors its opening). */
  onboarded?: boolean;
}

/**
 * The onboarding playbook (markdown) returned by `onboard {action: "start"}`:
 * instructions for the calling orchestrator to index an existing product's
 * codebase into the vault, structured by the Brainz ontology.
 */
export function onboardingPlaybook(opts: OnboardingPlaybookOptions = {}): string {
  const product = opts.productName?.trim();
  const repo = opts.repoHint?.trim();
  const heading = product ? `# Onboarding playbook — ${product}` : "# Onboarding playbook";
  const rerun = opts.onboarded
    ? "\n> This vault is already onboarded. Working through the playbook again refreshes the graph — update stale concepts rather than duplicating them.\n"
    : "";
  const where = repo ? ` The codebase lives at \`${repo}\`.` : "";

  return `${heading}
${rerun}
You are about to give your agent fleet a shared brain: a knowledge graph of the PRODUCT — not its files.${where} Work through the five steps below in this session, writing concepts back with \`upsert_concept\` as you go, and finish by calling \`onboard\` with \`{"action": "complete", "summary": "..."}\`.

## 1. Survey the artifact

- Inventory every application file in the repository. Exclude the noise: \`node_modules\`, \`dist\`, \`build\`, \`.git\`, lockfiles, binaries, and generated assets.
- Fan out subagents in parallel — one per app, package, or major directory — and have each report the product behavior its area implements, NOT a file-by-file tour.

## 2. Distill product knowledge, ontology first

A concept earns its place by answering a question a future agent will ask ("how does auth work?", "what rules govern billing?"). Structure what the subagents find with the Brainz ontology, top down:

1. \`domain\` — identify the product's high-level areas FIRST ("Authentication", "Search", "Billing"). Everything else hangs off domains; expect roughly 3–8.
2. \`feature\` — each concrete capability, \`part_of\` its domain.
3. \`story\` — user stories, the mapping facet between domains and features: a story is \`part_of\` its domain and \`realized_by\` the features that deliver it ("As a user I stay signed in across visits" → part_of Authentication, realized_by Session Refresh).
4. \`spec\` — technical specifications: the RULES under which a function must be performed. A spec \`governs\` the features/stories/domains it constrains ("Session tokens rotate every 15 minutes" governs Session Refresh).
5. \`workflow\` — multi-step user/system journeys across features (\`part_of\` its domain, \`depends_on\` the features it crosses, in order).
6. \`task\` — a unit of work NOT yet reflected in the codebase (a gap, fix, or follow-up). A task is \`part_of\` a domain, \`realizes\` the stories/features it will deliver, and is \`governed_by\` the specs it must satisfy; \`code_areas\` say where the work lands. Prefer the \`create_task\` tool. Tasks show up on the Kanban board and are claimed via \`take_task\`.
7. And wherever they surface: \`decision\` (choices made and why), \`constraint\` (hard limits), \`pattern\` (recurring implementation approaches), \`glossary\` (terms of art), \`concept\` (anything else worth keeping).

## 3. Anchor every concept to the code

Give EVERY concept a \`codeAreas\` list — rough paths or globs pointing at where that knowledge lives (e.g. \`["packages/core/src/vault.ts", "apps/cloud/src/routes/api/**"]\`). This is the payoff: an agent briefed by \`get_context\` learns the rules AND where to apply them.

## 4. Link the graph

- Write each concept with \`upsert_concept\`; reference other concepts with \`[[wiki-links]]\` in the body and typed \`relations\` for structure.
- Canonical relations (free-form strings — these are the conventions): \`part_of\`, \`realized_by\`, \`realizes\`, \`governs\`, \`governed_by\`, \`depends_on\`, \`constrains\`, \`supersedes\`, \`related_to\`.
- Direction matters: story —realized_by→ feature; spec —governs→ feature.

## 5. Size the effort from the codebase — index every area to saturation

There is NO flat concept cap. The right number of concepts is a function of the artifact, not a fixed target:

- **Size the effort first.** List the top-level source areas — every \`packages/*\`, every \`apps/*/src\` major subtree, and any other major directory — and budget concepts per area. Depth is decided PER AREA, not globally.
- **Index each area to saturation before moving on.** An area is done when a future agent could answer the questions its code raises from the graph alone — not when you hit some number.
- **For a LARGE project expect 200–800+ concepts.** A monorepo with many packages/apps will need hundreds. Do NOT stop at a few dozen — under-indexing a large repo is the failure this playbook exists to prevent. A small single-package tool may only need a few dozen; let the codebase decide.

## 6. The continue loop — survey → index → status → repeat

Onboarding a large repo is a LOOP, not a single pass. Brainz gives you a coverage signal each iteration so a fan-out doesn't stop early:

1. **Survey** the tree and build the list of top-level source areas (packages/*, apps/*/src subtrees, major dirs).
2. **Index the next uncovered area** to saturation with \`upsert_concept\`, anchoring every concept with \`codeAreas\`.
3. **Call \`onboard\` with \`{"action": "status", "areaList": [<your area list>]}\`** to see coverage: which areas are covered vs still uncovered, plus \`coveragePct\` and \`conceptCount\`. (Brainz can't read your repo, so YOU supply \`areaList\` from your survey.)
4. **If uncovered areas remain, take the next one and repeat** from step 2. Keep looping until coverage is broad.
5. **Only when coverage is broad, complete.** Call \`onboard\` with \`{"action": "complete", "summary": "<2–5 sentences: what was indexed, notable gaps>", "areaList": [<your area list>]}\`. Completion is coverage-gated: if too many areas still have zero concepts it is REJECTED with the list of uncovered areas — keep indexing, then complete. On success it marks the vault onboarded (the nudges stop) and stores your summary as the \`${ONBOARDING_SUMMARY_ID}\` concept.
`;
}

// --------------------------------------------------------------- coverage

/** One concept as computeCoverage needs it: just its code_areas. */
export interface CoverageConcept {
  /** Rough paths or globs pointing at where the concept's knowledge lives. */
  codeAreas?: string[] | null;
}

/**
 * Coverage of the repo's source areas by the vault's concepts.
 *
 * Deterministic: `covered` and `uncovered` preserve the input `areaList`
 * order (deduped). `coveragePct` is covered/total * 100, rounded to an
 * integer (0 when there are no areas).
 */
export interface Coverage {
  /** Areas that at least one concept's code_areas points under. */
  covered: string[];
  /** Areas no concept references — the work still to do. */
  uncovered: string[];
  /** Total concepts considered (length of the input list). */
  conceptCount: number;
  /** covered / total areas, 0–100, integer. */
  coveragePct: number;
}

/**
 * Normalize a path-ish string for prefix comparison: drop a leading `./`,
 * strip glob tails (`/**`, `/*`, trailing `*`), and trim a trailing slash.
 * Backslashes are normalized to `/` so Windows-style code_areas still match.
 */
function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  if (s.startsWith("./")) s = s.slice(2);
  // Strip a trailing glob segment/marker so "a/b/**", "a/b/*", "a/b*" → "a/b".
  s = s.replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/\*+$/, "");
  s = s.replace(/\/+$/, "");
  return s;
}

/**
 * True when `path` is at or under directory `area` (path-prefix match on
 * normalized, slash-delimited segments). Both are normalized first, so
 * globs on either side are tolerated. Segment-aware: `apps/crm` does NOT
 * match `apps/crm-legacy`, but DOES match `apps/crm` and `apps/crm/x`.
 */
function isUnder(path: string, area: string): boolean {
  const p = normalizePath(path);
  const a = normalizePath(area);
  if (a === "") return true; // an empty/root area covers everything
  if (p === "") return false;
  return p === a || p.startsWith(`${a}/`);
}

/**
 * Compute which source areas the vault's concepts cover.
 *
 * @param concepts the vault's concepts (only their `codeAreas` are read).
 * @param areaList top-level source areas to check (each package dir, each
 *   app src subtree, major dirs — supplied by the caller, who walked the repo).
 *
 * An area is COVERED if any concept has a code_area at or under it. Pure and
 * deterministic; the coverage machinery the `sync` epic reuses for drift.
 */
export function computeCoverage(
  concepts: readonly CoverageConcept[],
  areaList: readonly string[],
): Coverage {
  // Dedupe areas, preserving first-seen order for a stable result.
  const areas: string[] = [];
  const seen = new Set<string>();
  for (const raw of areaList) {
    if (typeof raw !== "string") continue;
    const key = normalizePath(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    areas.push(raw);
  }

  const allCodeAreas: string[] = [];
  for (const c of concepts) {
    for (const ca of c.codeAreas ?? []) {
      if (typeof ca === "string" && ca.trim() !== "") allCodeAreas.push(ca);
    }
  }

  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const area of areas) {
    if (allCodeAreas.some((ca) => isUnder(ca, area))) covered.push(area);
    else uncovered.push(area);
  }

  const coveragePct = areas.length === 0 ? 0 : Math.round((covered.length / areas.length) * 100);
  return { covered, uncovered, conceptCount: concepts.length, coveragePct };
}
