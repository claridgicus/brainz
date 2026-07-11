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

## 5. Calibrate, then complete

- Target 20–60 concepts for a mid-size product: enough to brief an agent well, few enough to stay true to the artifact.
- When the graph is written, call \`onboard\` with \`{"action": "complete", "summary": "<2–5 sentences: what was indexed, notable gaps>"}\`. That marks the vault onboarded (the nudges stop) and stores your summary as the \`${ONBOARDING_SUMMARY_ID}\` concept.
`;
}
