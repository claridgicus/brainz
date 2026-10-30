/**
 * Dreaming — autonomous background consolidation of a vault (SPEC-CLOUD
 * "Dreaming"). A sweep runs three phases:
 *
 *   light → stage what changed since the last sweep (duplicate candidates,
 *           task outcomes worth promoting, hygiene counts). No durable write.
 *   REM   → an LLM pass over the staged material that returns JSON PROPOSALS
 *           (merges, promotions, links, contradictions, themes). No durable write.
 *   deep  → gate every proposal, build the exact after-state of each touched
 *           concept, check the loss rail, and hand the plan to the host.
 *
 * Everything here is pure and Workers-safe: hosts (the cloud VaultDO, the local
 * core Vault) snapshot their concepts, inject an LLM through `DreamLlm`,
 * persist the JSON-serializable sweep state between steps, apply the plan, and
 * keep preimages for revert. The state machine is resumable so the DO can
 * chunk a sweep across alarm invocations (bounded comparisons and LLM calls
 * per step).
 */
import { extractWikiLinks } from "./note.js";
import { cosineSim } from "./search.js";
import { slugify } from "./slugify.js";
import type { TaskStatus } from "./types.js";

// ------------------------------------------------------------------ options

export interface DreamOptions {
  /** Embedding cosine at/above which two concepts are duplicate candidates. */
  duplicateCosine: number;
  /** Lexical (token Jaccard) similarity at/above which two concepts are duplicate candidates. */
  duplicateLexical: number;
  /** Most duplicate candidates staged per sweep (highest score kept). */
  maxDuplicateCandidates: number;
  /** Changed concepts compared against the vault per step. */
  lightBatch: number;
  /** Most LLM calls per step. */
  maxLlmCallsPerStep: number;
  /** Duplicate pairs / outcomes / changed concepts per REM call. */
  remPairsPerCall: number;
  remOutcomesPerCall: number;
  remChangedPerCall: number;
  /** Confidence gates per proposal kind. */
  minMergeConfidence: number;
  minPromoteConfidence: number;
  minLinkConfidence: number;
  minContradictionConfidence: number;
  /** Per-sweep caps per proposal kind. */
  maxMerges: number;
  maxPromotions: number;
  maxLinks: number;
  maxContradictions: number;
  /** Loss rail: touched existing concepts may not exceed max(allowance, floor(fraction × prior)). */
  maxTouchFraction: number;
  minTouchAllowance: number;
  /** Which proposal kinds deep may apply (a phase that is off is not asked of the model). */
  phases: DreamPhaseToggles;
}

/** Per-kind on/off switches for the REM/deep phases. */
export interface DreamPhaseToggles {
  merges: boolean;
  promotions: boolean;
  links: boolean;
  contradictions: boolean;
}

export const DREAM_DEFAULTS: Readonly<DreamOptions> = Object.freeze({
  duplicateCosine: 0.92,
  duplicateLexical: 0.8,
  maxDuplicateCandidates: 50,
  lightBatch: 200,
  maxLlmCallsPerStep: 3,
  remPairsPerCall: 6,
  remOutcomesPerCall: 4,
  remChangedPerCall: 12,
  minMergeConfidence: 0.8,
  minPromoteConfidence: 0.7,
  minLinkConfidence: 0.7,
  minContradictionConfidence: 0.6,
  maxMerges: 5,
  maxPromotions: 5,
  maxLinks: 10,
  maxContradictions: 3,
  maxTouchFraction: 0.2,
  minTouchAllowance: 3,
  phases: Object.freeze({ merges: true, promotions: true, links: true, contradictions: true }),
});

/** Concept types an outcome may be promoted into. */
export const DREAM_PROMOTABLE_TYPES = [
  "feature",
  "decision",
  "constraint",
  "spec",
  "pattern",
  "glossary",
  "concept",
] as const;

/** Concepts dreaming never merges, rewrites, or deletes. */
export const DREAM_PROTECTED_IDS: readonly string[] = ["product-onboarding-summary"];

/** Default dream cadence (hours) and its allowed range. */
export const DREAM_DEFAULT_CADENCE_HOURS = 24;
export const DREAM_MIN_CADENCE_HOURS = 1;
export const DREAM_MAX_CADENCE_HOURS = 168;

// -------------------------------------------------------------------- types

/** The full state of one concept as dreaming sees it (and as plans write it). */
export interface DreamConcept {
  id: string;
  title: string;
  type: string;
  status: string;
  product?: string;
  tags: string[];
  codeAreas: string[];
  taskStatus?: TaskStatus;
  takenBy?: string;
  takenAt?: string;
  doneAt?: string;
  relations: Record<string, string[]>;
  body: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DreamSnapshot {
  concepts: DreamConcept[];
  /** Embedding vector for a concept, or null when it has none. */
  vector?: (id: string) => Float32Array | null;
}

/** The LLM seam: Workers AI in cloud, injectable locally, swappable for Anthropic later. */
export interface DreamLlm {
  readonly name: string;
  complete(req: { system: string; user: string; maxTokens: number }): Promise<string>;
}

export type DreamTrigger = "alarm" | "manual";

export interface DuplicateCandidate {
  a: string;
  b: string;
  score: number;
  basis: "embedding" | "lexical";
}

export interface OutcomeCandidate {
  task: string;
  title: string;
  outcome: string;
}

export interface MergeProposal {
  keep: string;
  drop: string;
  confidence: number;
}
export interface PromoteProposal {
  task: string;
  title: string;
  type: string;
  body: string;
  confidence: number;
}
export interface LinkProposal {
  from: string;
  to: string;
  relation: string;
  confidence: number;
}
export interface ContradictionProposal {
  ids: string[];
  summary: string;
  confidence: number;
}
export interface RemProposals {
  merges: MergeProposal[];
  promotions: PromoteProposal[];
  links: LinkProposal[];
  contradictions: ContradictionProposal[];
  themes: string[];
}

export type DreamPhase = "light" | "rem" | "deep";

/** JSON-serializable, resumable state of an in-flight sweep. */
export interface DreamSweepState {
  id: string;
  trigger: DreamTrigger;
  startedAt: string;
  /** Previous sweep's start (changes after it are "recent"); null on the first sweep. */
  since: string | null;
  phase: DreamPhase;
  light: {
    changed: string[];
    cursor: number;
    duplicates: DuplicateCandidate[];
    outcomes: OutcomeCandidate[];
    orphans: number;
    pendingLinks: number;
    missingCodeAreas: number;
  };
  rem: {
    status: "pending" | "ok" | "skipped";
    reason?: string;
    cursor: number;
    chunks: number;
    calls: number;
    unparseable: number;
    proposals: RemProposals;
  };
}

export type DreamChangeKind = "merge" | "promote" | "link" | "contradiction";

export interface DreamAppliedChange {
  kind: DreamChangeKind;
  /** The concept the change landed on (merge survivor, new concept, link source, new task). */
  id: string;
  summary: string;
}

/** One concept-level write: `before` null ⇒ created; `after` null ⇒ removed (tombstoned). */
export interface DreamOp {
  id: string;
  before: DreamConcept | null;
  after: DreamConcept | null;
}

export type DreamRejectReason =
  | "below-threshold"
  | "not-staged"
  | "exists"
  | "missing"
  | "bad-type"
  | "cap"
  | "protected"
  | "phase-off"
  | "unparseable";

export interface DreamPlan {
  status: "apply" | "nothing" | "rejected";
  ops: DreamOp[];
  applied: DreamAppliedChange[];
  rejected: Partial<Record<DreamRejectReason, number>>;
  /** Existing concepts the plan removes or modifies. */
  touched: number;
  /** The loss-rail ceiling for `touched`. */
  allowance: number;
  /** The REM proposals behind `applied`, in the same order (propose mode stores these). */
  accepted: RemProposals;
}

export type DreamEntryStatus =
  | "applied"
  | "nothing-applied"
  | "rejected"
  | "light-only"
  | "reverted"
  | "proposed"
  | "dismissed";

/** One gated change a `propose` sweep holds back until a human/agent decides. */
export interface DreamProposal {
  /** Position in the entry's proposal list — what `apply {proposals}` names. */
  n: number;
  kind: DreamChangeKind;
  id: string;
  summary: string;
  decision: "pending" | "approved" | "rejected";
}

export interface DreamDiaryEntry {
  id: string;
  trigger: DreamTrigger;
  startedAt: string;
  finishedAt: string;
  status: DreamEntryStatus;
  /** The vault's dreaming mode when the sweep ran (absent on entries before settings existed). */
  mode?: DreamMode;
  light: {
    changed: number;
    duplicates: number;
    outcomes: number;
    orphans: number;
    pendingLinks: number;
    missingCodeAreas: number;
  };
  rem: {
    status: "ok" | "skipped";
    reason?: string;
    calls: number;
    proposals: number;
    themes: string[];
  };
  deep: {
    status: "applied" | "nothing-applied" | "rejected" | "skipped" | "proposed";
    reason?: string;
    touched: number;
    allowance: number;
    merged: number;
    promoted: number;
    linked: number;
    contradictions: number;
  };
  applied: DreamAppliedChange[];
  rejected: Partial<Record<DreamRejectReason, number>>;
  /** Propose mode: the held-back changes and what was decided for each. */
  proposals?: DreamProposal[];
  /** When the proposals were applied or dismissed. */
  decidedAt?: string;
  revertedAt?: string;
  markdown: string;
}

// ------------------------------------------------------------------ helpers

function opts(o?: Partial<DreamOptions>): DreamOptions {
  return { ...DREAM_DEFAULTS, ...(o ?? {}), phases: { ...DREAM_DEFAULTS.phases, ...(o?.phases ?? {}) } };
}

function isMergeable(c: DreamConcept): boolean {
  return c.type !== "task" && !DREAM_PROTECTED_IDS.includes(c.id);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "into", "its",
  "has", "have", "not", "but", "you", "your", "can", "all", "any", "our", "out", "use",
]);

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Lexical similarity: identical title slugs ⇒ 1, else token Jaccard over title + body. */
export function lexicalSimilarity(a: DreamConcept, b: DreamConcept): number {
  if (slugify(a.title) !== "" && slugify(a.title) === slugify(b.title)) return 1;
  return jaccard(tokens(`${a.title} ${a.body}`), tokens(`${b.title} ${b.body}`));
}

/** Text after the LAST `## Outcome` heading of a task body, or null. */
export function extractOutcome(body: string): string | null {
  const re = /^##\s+Outcome\s*$/gim;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) last = m.index + m[0].length;
  if (last < 0) return null;
  const rest = body.slice(last);
  const next = rest.search(/^##\s+/m);
  const text = (next >= 0 ? rest.slice(0, next) : rest).trim();
  return text ? text.slice(0, 1500) : null;
}

function isAfter(ts: string | undefined, since: string | null): boolean {
  if (since === null) return true;
  if (!ts) return false;
  return ts > since;
}

function linkTargets(c: DreamConcept): string[] {
  const out = new Set<string>();
  for (const targets of Object.values(c.relations)) for (const t of targets) out.add(t);
  for (const t of extractWikiLinks(c.body)) out.add(t);
  out.delete(c.id);
  return [...out];
}

function excerpt(body: string, max = 300): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function clone(c: DreamConcept): DreamConcept {
  return JSON.parse(JSON.stringify(c)) as DreamConcept;
}

function emptyProposals(): RemProposals {
  return { merges: [], promotions: [], links: [], contradictions: [], themes: [] };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

// -------------------------------------------------------------------- light

/**
 * Begin a sweep: compute what changed since `since`, the outcome candidates,
 * and the hygiene counts (all O(n)). Duplicate scanning happens in
 * {@link advanceSweep} steps.
 */
export function startSweep(args: {
  id: string;
  trigger: DreamTrigger;
  now: string;
  since: string | null;
  snapshot: DreamSnapshot;
}): DreamSweepState {
  const { concepts } = args.snapshot;
  const ids = new Set(concepts.map((c) => c.id));
  const changed = concepts
    .filter((c) => isMergeable(c) && isAfter(c.updatedAt ?? c.createdAt, args.since))
    .map((c) => c.id)
    .sort();

  const derived = new Set<string>();
  for (const c of concepts) for (const t of c.relations.derived_from ?? []) derived.add(t);
  const outcomes: OutcomeCandidate[] = [];
  for (const c of concepts) {
    if (c.type !== "task" || c.taskStatus !== "done" || derived.has(c.id)) continue;
    if (!isAfter(c.doneAt ?? c.updatedAt, args.since)) continue;
    const outcome = extractOutcome(c.body);
    if (outcome) outcomes.push({ task: c.id, title: c.title, outcome });
  }
  outcomes.sort((a, b) => a.task.localeCompare(b.task));

  const inbound = new Set<string>();
  const pending = new Set<string>();
  const hasOut = new Set<string>();
  for (const c of concepts) {
    const targets = linkTargets(c);
    if (targets.length > 0) hasOut.add(c.id);
    for (const t of targets) {
      inbound.add(t);
      if (!ids.has(t)) pending.add(t);
    }
  }
  const orphans = concepts.filter((c) => !hasOut.has(c.id) && !inbound.has(c.id)).length;
  const missingCodeAreas = concepts.filter(
    (c) => c.type !== "task" && c.codeAreas.length === 0,
  ).length;

  return {
    id: args.id,
    trigger: args.trigger,
    startedAt: args.now,
    since: args.since,
    phase: "light",
    light: {
      changed,
      cursor: 0,
      duplicates: [],
      outcomes,
      orphans,
      pendingLinks: pending.size,
      missingCodeAreas,
    },
    rem: {
      status: "pending",
      cursor: 0,
      chunks: 0,
      calls: 0,
      unparseable: 0,
      proposals: emptyProposals(),
    },
  };
}

/** True when nothing changed since the last sweep — hosts record the time and skip the diary. */
export function isEmptySweep(state: DreamSweepState): boolean {
  return state.light.changed.length === 0 && state.light.outcomes.length === 0;
}

function scanDuplicates(state: DreamSweepState, snapshot: DreamSnapshot, o: DreamOptions): void {
  const eligible = snapshot.concepts.filter(isMergeable);
  const byId = new Map(eligible.map((c) => [c.id, c]));
  const changedSet = new Set(state.light.changed);
  const batch = state.light.changed.slice(state.light.cursor, state.light.cursor + o.lightBatch);
  const found = new Map(state.light.duplicates.map((d) => [pairKey(d.a, d.b), d]));
  const tokenCache = new Map<string, Set<string>>();
  const tok = (c: DreamConcept): Set<string> => {
    let t = tokenCache.get(c.id);
    if (!t) {
      t = tokens(`${c.title} ${c.body}`);
      tokenCache.set(c.id, t);
    }
    return t;
  };
  for (const id of batch) {
    const a = byId.get(id);
    if (!a) continue;
    const va = snapshot.vector?.(a.id) ?? null;
    for (const b of eligible) {
      if (b.id === a.id) continue;
      // A pair of two changed concepts is scored once, from the smaller id.
      if (changedSet.has(b.id) && b.id < a.id) continue;
      const key = pairKey(a.id, b.id);
      if (found.has(key)) continue;
      const vb = snapshot.vector?.(b.id) ?? null;
      let score: number;
      let basis: DuplicateCandidate["basis"];
      if (va && vb && va.length === vb.length) {
        score = cosineSim(va, vb);
        basis = "embedding";
        if (score < o.duplicateCosine) continue;
      } else {
        const sameTitle = slugify(a.title) !== "" && slugify(a.title) === slugify(b.title);
        score = sameTitle ? 1 : jaccard(tok(a), tok(b));
        basis = "lexical";
        if (score < o.duplicateLexical) continue;
      }
      const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      found.set(key, { a: x, b: y, score: Math.round(score * 1000) / 1000, basis });
    }
  }
  state.light.duplicates = [...found.values()]
    .sort((p, q) => q.score - p.score || p.a.localeCompare(q.a) || p.b.localeCompare(q.b))
    .slice(0, o.maxDuplicateCandidates);
  state.light.cursor += batch.length;
}

// ---------------------------------------------------------------------- REM

/** Phase toggle → the REM response key it governs. */
const PHASE_KEYS: [keyof DreamPhaseToggles, keyof RemProposals][] = [
  ["merges", "merges"],
  ["promotions", "promotions"],
  ["links", "links"],
  ["contradictions", "contradictions"],
];

export const DREAM_REM_SYSTEM = [
  "You consolidate a product knowledge graph while its agents are idle (\"dreaming\").",
  "You receive staged material: candidate duplicate concept pairs, finished task outcomes, and recently changed concepts.",
  "Return ONLY a JSON object, no prose, with these keys (use [] when you have nothing):",
  '{"merges":[{"keep":"<id>","drop":"<id>","confidence":0..1}],',
  ' "promotions":[{"task":"<task id>","title":"<concept title>","type":"feature|decision|constraint|spec|pattern|glossary|concept","body":"<markdown, 1-6 sentences>","confidence":0..1}],',
  ' "links":[{"from":"<id>","to":"<id>","relation":"related_to|depends_on|part_of|constrains|governs|realized_by|supersedes","confidence":0..1}],',
  ' "contradictions":[{"ids":["<id>","<id>"],"summary":"<one sentence>","confidence":0..1}],',
  ' "themes":["<short recurring theme>"]}',
  "Rules: merge only pairs listed under duplicates, and only when both describe the SAME thing (keep the richer, better-connected one).",
  "Promote an outcome only when it states durable product knowledge (a decision, constraint, rule, or capability) that is not already a concept; write the body as that knowledge, not as a task log.",
  "Link only ids that appear in the material. Report contradictions instead of resolving them. Be conservative: low confidence is better than a wrong change.",
  'If the material has an "off" list, return [] for every key named in it.',
].join("\n");

/** The REM user message for one chunk of staged material (JSON for the model). */
export function remChunkPrompt(
  state: DreamSweepState,
  snapshot: DreamSnapshot,
  chunk: number,
  options?: Partial<DreamOptions>,
): string {
  const o = opts(options);
  const byId = new Map(snapshot.concepts.map((c) => [c.id, c]));
  const brief = (id: string) => {
    const c = byId.get(id);
    return c ? { id, title: c.title, type: c.type, excerpt: excerpt(c.body) } : { id };
  };
  const dups = o.phases.merges
    ? state.light.duplicates.slice(chunk * o.remPairsPerCall, (chunk + 1) * o.remPairsPerCall)
    : [];
  const outs = o.phases.promotions
    ? state.light.outcomes.slice(chunk * o.remOutcomesPerCall, (chunk + 1) * o.remOutcomesPerCall)
    : [];
  const off = PHASE_KEYS.filter(([phase]) => !o.phases[phase]).map(([, key]) => key);
  const changed = state.light.changed.slice(
    chunk * o.remChangedPerCall,
    (chunk + 1) * o.remChangedPerCall,
  );
  return JSON.stringify(
    {
      duplicates: dups.map((d) => ({ a: brief(d.a), b: brief(d.b), similarity: d.score })),
      outcomes: outs.map((x) => ({ task: x.task, title: x.title, outcome: x.outcome })),
      changed: changed.map(brief),
      ...(off.length > 0 ? { off } : {}),
    },
    null,
    1,
  );
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
function str(v: unknown, max = 4000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}

/**
 * Parse a REM response into proposals. Tolerates prose/code fences around the
 * JSON object; returns null when no usable object is present.
 */
export function parseRemResponse(text: string): RemProposals | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    merges: arr(r.merges)
      .map((m) => ({ keep: str(m.keep, 200), drop: str(m.drop, 200), confidence: num(m.confidence) }))
      .filter((m) => m.keep && m.drop),
    promotions: arr(r.promotions)
      .map((p) => ({
        task: str(p.task, 200),
        title: str(p.title, 200),
        type: str(p.type, 40).toLowerCase(),
        body: str(p.body),
        confidence: num(p.confidence),
      }))
      .filter((p) => p.task && p.title),
    links: arr(r.links)
      .map((l) => ({
        from: str(l.from, 200),
        to: str(l.to, 200),
        relation: str(l.relation, 40) || "related_to",
        confidence: num(l.confidence),
      }))
      .filter((l) => l.from && l.to),
    contradictions: arr(r.contradictions)
      .map((c) => ({
        ids: Array.isArray(c.ids) ? c.ids.map((x) => str(x, 200)).filter(Boolean) : [],
        summary: str(c.summary, 600),
        confidence: num(c.confidence),
      }))
      .filter((c) => c.ids.length >= 2 && c.summary),
    themes: (Array.isArray(r.themes) ? r.themes : [])
      .map((t) => str(t, 120))
      .filter(Boolean)
      .slice(0, 5),
  };
}

// ------------------------------------------------------------- the stepper

/**
 * Advance a sweep by ONE bounded step and return the new state (the input is
 * not mutated): light scans up to `lightBatch` changed concepts for duplicates;
 * REM makes up to `maxLlmCallsPerStep` LLM calls. Deep is not a step — when
 * `phase === "deep"` call {@link planDeep}. With `llm: null` REM is skipped,
 * recording `skipReason` (default "no LLM provider available") — hosts pass
 * e.g. a spend-cap or kill-switch reason.
 */
export async function advanceSweep(
  input: DreamSweepState,
  snapshot: DreamSnapshot,
  args: { llm: DreamLlm | null; options?: Partial<DreamOptions>; skipReason?: string },
): Promise<DreamSweepState> {
  const o = opts(args.options);
  const skipReason = args.skipReason ?? "no LLM provider available";
  const state = JSON.parse(JSON.stringify(input)) as DreamSweepState;
  if (state.phase === "light") {
    scanDuplicates(state, snapshot, o);
    if (state.light.cursor >= state.light.changed.length) {
      state.phase = "rem";
      state.rem.chunks = Math.max(
        1,
        Math.ceil(state.light.duplicates.length / o.remPairsPerCall),
        Math.ceil(state.light.outcomes.length / o.remOutcomesPerCall),
        Math.ceil(state.light.changed.length / o.remChangedPerCall),
      );
      if (!args.llm) {
        state.rem.status = "skipped";
        state.rem.reason = skipReason;
        state.phase = "deep";
      }
    }
    return state;
  }
  if (state.phase === "rem") {
    if (!args.llm) {
      state.rem.status = "skipped";
      state.rem.reason = skipReason;
      state.phase = "deep";
      return state;
    }
    let calls = 0;
    while (state.rem.cursor < state.rem.chunks && calls < o.maxLlmCallsPerStep) {
      const user = remChunkPrompt(state, snapshot, state.rem.cursor, o);
      let text: string;
      try {
        calls++;
        state.rem.calls++;
        text = await args.llm.complete({ system: DREAM_REM_SYSTEM, user, maxTokens: 1500 });
      } catch (err) {
        state.rem.status = "skipped";
        state.rem.reason = `llm-error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        state.phase = "deep";
        return state;
      }
      const parsed = parseRemResponse(text);
      if (!parsed) state.rem.unparseable++;
      else {
        const p = state.rem.proposals;
        p.merges.push(...parsed.merges);
        p.promotions.push(...parsed.promotions);
        p.links.push(...parsed.links);
        p.contradictions.push(...parsed.contradictions);
        for (const t of parsed.themes) if (!p.themes.includes(t) && p.themes.length < 8) p.themes.push(t);
      }
      state.rem.cursor++;
    }
    if (state.rem.cursor >= state.rem.chunks) {
      state.rem.status = "ok";
      state.phase = "deep";
    }
  }
  return state;
}

// --------------------------------------------------------------------- deep

const RELATION_RE = /^[a-z][a-z0-9_]{0,39}$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite every reference to `from` (relations + wiki-links) to `to`. Returns true if changed. */
function redirect(c: DreamConcept, from: string, to: string): boolean {
  let changed = false;
  const relations: Record<string, string[]> = {};
  for (const [rel, targets] of Object.entries(c.relations)) {
    const next: string[] = [];
    for (const t of targets) {
      const v = t === from ? to : t;
      if (t === from && v === c.id) continue; // a redirect never creates a self-edge
      if (!next.includes(v)) next.push(v);
    }
    if (next.length !== targets.length || next.some((v, i) => v !== targets[i])) changed = true;
    if (next.length > 0) relations[rel] = next;
  }
  const re = new RegExp(`\\[\\[\\s*${escapeRe(from)}\\s*(\\|[^\\]]*)?\\]\\]`, "g");
  const body = c.body.replace(re, (_m, label: string | undefined) => `[[${to}${label ?? ""}]]`);
  if (body !== c.body) changed = true;
  if (changed) {
    c.relations = relations;
    c.body = body;
  }
  return changed;
}

function references(c: DreamConcept, id: string): boolean {
  for (const targets of Object.values(c.relations)) if (targets.includes(id)) return true;
  return extractWikiLinks(c.body).includes(id);
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Gate REM proposals and build the plan: the exact after-state of every
 * concept the dream would create, modify, or remove. When the loss rail trips
 * the plan is `rejected` with no ops. Pure: the snapshot is not mutated.
 */
export function planDeep(
  state: DreamSweepState,
  snapshot: DreamSnapshot,
  args: { now: string; options?: Partial<DreamOptions> },
): DreamPlan {
  const o = opts(args.options);
  const before = new Map(snapshot.concepts.map((c) => [c.id, c]));
  const work = new Map(snapshot.concepts.map((c) => [c.id, clone(c)]));
  const touched = new Set<string>();
  const created = new Set<string>();
  const applied: DreamAppliedChange[] = [];
  const rejected: Partial<Record<DreamRejectReason, number>> = {};
  const reject = (r: DreamRejectReason) => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  if (state.rem.unparseable > 0) rejected.unparseable = state.rem.unparseable;
  const markTouched = (id: string) => {
    if (before.has(id)) touched.add(id);
  };

  const staged = new Set(state.light.duplicates.map((d) => pairKey(d.a, d.b)));
  const stagedOutcomes = new Map(state.light.outcomes.map((x) => [x.task, x]));
  const p = state.rem.proposals;
  const accepted = emptyProposals();
  accepted.themes = [...p.themes];

  // merges
  let merges = 0;
  const seenMerge = new Set<string>();
  for (const m of p.merges) {
    const key = pairKey(m.keep, m.drop);
    if (seenMerge.has(key)) continue;
    seenMerge.add(key);
    if (!o.phases.merges) {
      reject("phase-off");
      continue;
    }
    if (m.keep === m.drop || !staged.has(key)) {
      reject("not-staged");
      continue;
    }
    if (m.confidence < o.minMergeConfidence) {
      reject("below-threshold");
      continue;
    }
    const keep = work.get(m.keep);
    const drop = work.get(m.drop);
    if (!keep || !drop) {
      reject("missing");
      continue;
    }
    if (!isMergeable(keep) || !isMergeable(drop)) {
      reject("protected");
      continue;
    }
    if (merges >= o.maxMerges) {
      reject("cap");
      continue;
    }
    merges++;
    accepted.merges.push(m);
    keep.tags = union(keep.tags, drop.tags);
    keep.codeAreas = union(keep.codeAreas, drop.codeAreas);
    for (const [rel, targets] of Object.entries(drop.relations)) {
      const absorbed = targets.filter((t) => t !== keep.id && t !== drop.id);
      if (absorbed.length > 0) keep.relations[rel] = union(keep.relations[rel] ?? [], absorbed);
    }
    const dropBody = drop.body.trim();
    if (dropBody && !keep.body.includes(dropBody)) {
      const base = keep.body.replace(/\s+$/, "");
      keep.body = `${base}\n\n## Merged from ${drop.title} (${drop.id})\n\n${dropBody}\n`;
    }
    redirect(keep, drop.id, keep.id);
    markTouched(keep.id);
    work.delete(drop.id);
    markTouched(drop.id);
    let redirected = 0;
    for (const c of work.values()) {
      if (c.id === keep.id || !references(c, drop.id)) continue;
      if (redirect(c, drop.id, keep.id)) {
        redirected++;
        markTouched(c.id);
      }
    }
    applied.push({
      kind: "merge",
      id: keep.id,
      summary: `merged "${drop.id}" into "${keep.id}" (${redirected} referencing concept${redirected === 1 ? "" : "s"} redirected)`,
    });
  }

  // links
  let links = 0;
  for (const l of p.links) {
    const relation = RELATION_RE.test(l.relation) ? l.relation : "related_to";
    if (!o.phases.links) {
      reject("phase-off");
      continue;
    }
    if (l.confidence < o.minLinkConfidence) {
      reject("below-threshold");
      continue;
    }
    const from = work.get(l.from);
    if (!from || !work.has(l.to) || l.from === l.to) {
      reject("missing");
      continue;
    }
    if (DREAM_PROTECTED_IDS.includes(from.id)) {
      reject("protected");
      continue;
    }
    if ((from.relations[relation] ?? []).includes(l.to)) {
      reject("exists");
      continue;
    }
    if (links >= o.maxLinks) {
      reject("cap");
      continue;
    }
    links++;
    accepted.links.push(l);
    from.relations[relation] = [...(from.relations[relation] ?? []), l.to];
    markTouched(from.id);
    applied.push({ kind: "link", id: from.id, summary: `linked "${from.id}" ${relation} "${l.to}"` });
  }

  // promotions
  let promotions = 0;
  for (const pr of p.promotions) {
    if (!o.phases.promotions) {
      reject("phase-off");
      continue;
    }
    const source = stagedOutcomes.get(pr.task);
    if (!source) {
      reject("not-staged");
      continue;
    }
    if (pr.confidence < o.minPromoteConfidence) {
      reject("below-threshold");
      continue;
    }
    if (!(DREAM_PROMOTABLE_TYPES as readonly string[]).includes(pr.type) || !pr.body) {
      reject("bad-type");
      continue;
    }
    const id = slugify(pr.title);
    if (!id || work.has(id) || before.has(id)) {
      reject("exists");
      continue;
    }
    if (promotions >= o.maxPromotions) {
      reject("cap");
      continue;
    }
    promotions++;
    accepted.promotions.push(pr);
    stagedOutcomes.delete(pr.task);
    const task = work.get(pr.task);
    work.set(id, {
      id,
      title: pr.title,
      type: pr.type,
      status: "active",
      tags: ["dreamed"],
      codeAreas: task ? [...task.codeAreas] : [],
      relations: { derived_from: [pr.task] },
      body: `${pr.body.replace(/\s+$/, "")}\n\n_Promoted by dream \`${state.id}\` from the outcome of task \`${pr.task}\`._\n`,
      createdAt: args.now,
      updatedAt: args.now,
    });
    created.add(id);
    applied.push({ kind: "promote", id, summary: `promoted the outcome of "${pr.task}" into ${pr.type} "${id}"` });
  }

  // contradictions → open tasks for a human/agent
  let contradictions = 0;
  for (const c of p.contradictions) {
    if (!o.phases.contradictions) {
      reject("phase-off");
      continue;
    }
    if (c.confidence < o.minContradictionConfidence) {
      reject("below-threshold");
      continue;
    }
    const ids = [...new Set(c.ids)].sort();
    if (ids.length < 2 || ids.some((id) => !work.has(id))) {
      reject("missing");
      continue;
    }
    const id = slugify(`dream-contradiction-${ids.join("-")}`).slice(0, 96).replace(/-+$/, "");
    if (work.has(id)) {
      reject("exists");
      continue;
    }
    if (contradictions >= o.maxContradictions) {
      reject("cap");
      continue;
    }
    contradictions++;
    accepted.contradictions.push(c);
    const titles = ids.map((x) => work.get(x)?.title ?? x);
    work.set(id, {
      id,
      title: `Resolve contradiction: ${titles.join(" vs ")}`.slice(0, 200),
      type: "task",
      status: "active",
      tags: ["dream", "contradiction"],
      codeAreas: [],
      taskStatus: "open",
      relations: { related_to: ids },
      body:
        `${c.summary}\n\nFiled by dream \`${state.id}\`. Dreaming never picks a side: decide which ` +
        `concept is right, then update or supersede the other.\n`,
      createdAt: args.now,
      updatedAt: args.now,
    });
    created.add(id);
    applied.push({ kind: "contradiction", id, summary: `filed task "${id}" for ${ids.join(" vs ")}` });
  }

  const prior = snapshot.concepts.length;
  const allowance = Math.max(o.minTouchAllowance, Math.floor(o.maxTouchFraction * prior));
  if (touched.size > allowance) {
    return {
      status: "rejected",
      ops: [],
      applied: [],
      rejected,
      touched: touched.size,
      allowance,
      accepted: { ...emptyProposals(), themes: accepted.themes },
    };
  }
  const ops: DreamOp[] = [];
  for (const id of [...touched].sort()) {
    const after = work.get(id) ?? null;
    if (after) after.updatedAt = args.now;
    ops.push({ id, before: clone(before.get(id)!), after: after ? clone(after) : null });
  }
  for (const id of [...created].sort()) ops.push({ id, before: null, after: clone(work.get(id)!) });
  return {
    status: ops.length > 0 ? "apply" : "nothing",
    ops,
    applied,
    rejected,
    touched: touched.size,
    allowance,
    accepted,
  };
}

// -------------------------------------------------------------------- diary

/**
 * Build the Dream Diary entry for a finished sweep (`plan` null ⇒ deep
 * skipped). In `propose` mode an applicable plan is NOT applied: the entry is
 * `proposed` and lists the gated changes as numbered pending proposals.
 */
export function diaryEntry(
  state: DreamSweepState,
  plan: DreamPlan | null,
  finishedAt: string,
  extra: { mode?: DreamMode } = {},
): DreamDiaryEntry {
  const proposing = extra.mode === "propose" && plan?.status === "apply";
  const count = (k: DreamChangeKind) =>
    proposing ? 0 : (plan?.applied.filter((a) => a.kind === k).length ?? 0);
  const p = state.rem.proposals;
  const remStatus: "ok" | "skipped" = state.rem.status === "ok" ? "ok" : "skipped";
  const deepStatus: DreamDiaryEntry["deep"]["status"] = !plan
    ? "skipped"
    : proposing
      ? "proposed"
      : plan.status === "apply"
      ? "applied"
      : plan.status === "rejected"
        ? "rejected"
        : "nothing-applied";
  const status: DreamEntryStatus = !plan
    ? "light-only"
    : deepStatus === "proposed"
      ? "proposed"
      : deepStatus === "applied"
      ? "applied"
      : deepStatus === "rejected"
        ? "rejected"
        : "nothing-applied";
  const entry: DreamDiaryEntry = {
    id: state.id,
    trigger: state.trigger,
    startedAt: state.startedAt,
    finishedAt,
    status,
    ...(extra.mode ? { mode: extra.mode } : {}),
    light: {
      changed: state.light.changed.length,
      duplicates: state.light.duplicates.length,
      outcomes: state.light.outcomes.length,
      orphans: state.light.orphans,
      pendingLinks: state.light.pendingLinks,
      missingCodeAreas: state.light.missingCodeAreas,
    },
    rem: {
      status: remStatus,
      ...(state.rem.reason ? { reason: state.rem.reason } : {}),
      calls: state.rem.calls,
      proposals: p.merges.length + p.promotions.length + p.links.length + p.contradictions.length,
      themes: [...p.themes],
    },
    deep: {
      status: deepStatus,
      ...(!plan
        ? { reason: "REM skipped" }
        : plan.status === "rejected"
          ? { reason: `loss threshold: would touch ${plan.touched} existing concepts (allowed ${plan.allowance})` }
          : {}),
      touched: plan?.touched ?? 0,
      allowance: plan?.allowance ?? 0,
      merged: count("merge"),
      promoted: count("promote"),
      linked: count("link"),
      contradictions: count("contradiction"),
    },
    applied: proposing ? [] : (plan?.applied ?? []),
    rejected: plan?.rejected ?? {},
    ...(proposing
      ? {
          proposals: plan.applied.map((a, n) => ({
            n,
            kind: a.kind,
            id: a.id,
            summary: a.summary,
            decision: "pending" as const,
          })),
        }
      : {}),
    markdown: "",
  };
  entry.markdown = renderDiaryEntry(entry);
  return entry;
}

/** Flatten proposals in planDeep's order (merges, links, promotions, contradictions). */
function flattenProposals(p: RemProposals): { kind: keyof RemProposals; item: unknown }[] {
  return [
    ...p.merges.map((item) => ({ kind: "merges" as const, item })),
    ...p.links.map((item) => ({ kind: "links" as const, item })),
    ...p.promotions.map((item) => ({ kind: "promotions" as const, item })),
    ...p.contradictions.map((item) => ({ kind: "contradictions" as const, item })),
  ];
}

/**
 * The subset of a propose sweep's accepted proposals named by `ns` (positions
 * in the entry's `proposals` list; omitted ⇒ all). Unknown positions are ignored.
 */
export function selectProposals(accepted: RemProposals, ns?: readonly number[]): RemProposals {
  const out: RemProposals = { ...emptyProposals(), themes: [...accepted.themes] };
  const keep = ns === undefined ? null : new Set(ns);
  flattenProposals(accepted).forEach(({ kind, item }, n) => {
    if (keep && !keep.has(n)) return;
    (out[kind] as unknown[]).push(item);
  });
  return out;
}

/**
 * Record the decision on a `proposed` entry: `selected` (positions) were
 * approved and re-planned into `plan` (null ⇒ nothing approved ⇒ dismissed);
 * every other proposal is rejected.
 */
export function decideEntry(
  entry: DreamDiaryEntry,
  plan: DreamPlan | null,
  selected: readonly number[],
  decidedAt: string,
): DreamDiaryEntry {
  const chosen = new Set(selected);
  const proposals = (entry.proposals ?? []).map((p) => ({
    ...p,
    decision: chosen.has(p.n) ? ("approved" as const) : ("rejected" as const),
  }));
  const count = (k: DreamChangeKind) => plan?.applied.filter((a) => a.kind === k).length ?? 0;
  const rejected: Partial<Record<DreamRejectReason, number>> = { ...entry.rejected };
  for (const [r, n] of Object.entries(plan?.rejected ?? {}) as [DreamRejectReason, number][]) {
    if (r === "unparseable") continue; // already counted when the sweep ran
    rejected[r] = (rejected[r] ?? 0) + n;
  }
  const deepStatus: DreamDiaryEntry["deep"]["status"] =
    !plan || plan.status === "nothing"
      ? "nothing-applied"
      : plan.status === "rejected"
        ? "rejected"
        : "applied";
  const status: DreamEntryStatus = !plan
    ? "dismissed"
    : deepStatus === "applied"
      ? "applied"
      : deepStatus === "rejected"
        ? "rejected"
        : "nothing-applied";
  const next: DreamDiaryEntry = {
    ...entry,
    status,
    deep: {
      status: deepStatus,
      ...(plan?.status === "rejected"
        ? { reason: `loss threshold: would touch ${plan.touched} existing concepts (allowed ${plan.allowance})` }
        : {}),
      touched: plan?.touched ?? 0,
      allowance: plan?.allowance ?? entry.deep.allowance,
      merged: count("merge"),
      promoted: count("promote"),
      linked: count("link"),
      contradictions: count("contradiction"),
    },
    applied: plan?.applied ?? [],
    rejected,
    proposals,
    decidedAt,
    markdown: "",
  };
  next.markdown = renderDiaryEntry(next);
  return next;
}

/** Human-readable markdown for one diary entry (counts and ids, not dumps). */
export function renderDiaryEntry(e: DreamDiaryEntry): string {
  const lines: string[] = [];
  lines.push(`## Dream ${e.id} — ${e.status}`);
  lines.push("");
  lines.push(`${e.trigger === "alarm" ? "Nightly" : "Manual"} sweep, ${e.startedAt} → ${e.finishedAt}.`);
  if (e.revertedAt) lines.push(`Reverted at ${e.revertedAt}.`);
  lines.push("");
  const l = e.light;
  lines.push(
    `- **Light:** ${l.changed} changed concept${l.changed === 1 ? "" : "s"}, ${l.duplicates} duplicate candidate${l.duplicates === 1 ? "" : "s"}, ` +
      `${l.outcomes} task outcome${l.outcomes === 1 ? "" : "s"} to consider; hygiene — ${l.orphans} orphan${l.orphans === 1 ? "" : "s"}, ` +
      `${l.pendingLinks} pending link${l.pendingLinks === 1 ? "" : "s"}, ${l.missingCodeAreas} without code areas.`,
  );
  lines.push(
    e.rem.status === "ok"
      ? `- **REM:** ${e.rem.calls} LLM call${e.rem.calls === 1 ? "" : "s"}, ${e.rem.proposals} proposal${e.rem.proposals === 1 ? "" : "s"}.` +
          (e.rem.themes.length > 0 ? ` Themes: ${e.rem.themes.join("; ")}.` : "")
      : `- **REM:** skipped (${e.rem.reason ?? "unavailable"}).`,
  );
  const d = e.deep;
  if (d.status === "skipped") lines.push(`- **Deep:** skipped (${d.reason ?? "REM skipped"}).`);
  else if (d.status === "proposed")
    lines.push(
      `- **Deep:** propose mode — ${e.proposals?.length ?? 0} change${(e.proposals?.length ?? 0) === 1 ? "" : "s"} held for approval ` +
        `(${d.touched}/${d.allowance} existing concepts would be touched). Nothing was written.`,
    );
  else if (d.status === "rejected") lines.push(`- **Deep:** rejected — ${d.reason}. Nothing was written.`);
  else
    lines.push(
      `- **Deep:** ${d.merged} merged, ${d.promoted} promoted, ${d.linked} linked, ${d.contradictions} contradiction task${d.contradictions === 1 ? "" : "s"} ` +
        `(${d.touched}/${d.allowance} existing concepts touched).`,
    );
  const rejected = Object.entries(e.rejected).filter(([, n]) => (n ?? 0) > 0);
  if (rejected.length > 0) {
    lines.push(`- **Rejected proposals:** ${rejected.map(([r, n]) => `${n} ${r}`).join(", ")}.`);
  }
  if (e.decidedAt) lines.push(`- **Decided:** ${e.decidedAt}.`);
  if (e.applied.length > 0) {
    lines.push("");
    for (const a of e.applied) lines.push(`- ${a.kind}: ${a.summary}`);
  }
  if (e.proposals && e.proposals.length > 0) {
    lines.push("");
    for (const p of e.proposals) lines.push(`- [${p.decision}] #${p.n} ${p.kind}: ${p.summary}`);
  }
  return `${lines.join("\n")}\n`;
}

/** New dream id: `dream-<compact UTC timestamp>` (unique enough per vault; hosts may suffix). */
export function dreamId(nowIso: string): string {
  return `dream-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}`;
}

/** Clamp a cadence to the allowed range. */
export function clampCadenceHours(h: number): number {
  if (!Number.isFinite(h)) return DREAM_DEFAULT_CADENCE_HOURS;
  return Math.min(DREAM_MAX_CADENCE_HOURS, Math.max(DREAM_MIN_CADENCE_HOURS, Math.round(h)));
}

// ----------------------------------------------------------------- settings

/** apply: write changes (default) · propose: hold them for approval · light-only: never call an LLM. */
export type DreamMode = "apply" | "propose" | "light-only";
export const DREAM_MODES: readonly DreamMode[] = ["apply", "propose", "light-only"];

/** Which LLM a cloud vault's REM may use: the default order, Workers AI only, or the owner's key only. */
export type DreamLlmProvider = "auto" | "workers-ai" | "byok";
export const DREAM_LLM_PROVIDERS: readonly DreamLlmProvider[] = ["auto", "workers-ai", "byok"];

/** Per-vault dreaming settings (SPEC-CLOUD "Dreaming → Per-vault settings"). */
export interface DreamSettings {
  enabled: boolean;
  cadenceHours: number;
  /** Preferred UTC hour for a sweep (cadence ≥ 24h only); null = no preference. */
  runHourUtc: number | null;
  mode: DreamMode;
  phases: DreamPhaseToggles;
  thresholds: { merge: number; promote: number; link: number; contradiction: number };
  caps: { maxMerges: number; maxPromotions: number; maxLinks: number; maxContradictions: number };
  /** May only be stricter than the defaults (the rail is a hard floor). */
  lossRail: { maxTouchFraction: number; minTouchAllowance: number };
  /** Cloud only: provider preference and a BYOK model override. */
  llm: { provider: DreamLlmProvider; model: string | null };
}

/** A partial update: nested objects merge field by field. */
export interface DreamSettingsPatch {
  enabled?: boolean;
  cadenceHours?: number;
  runHourUtc?: number | null;
  mode?: DreamMode;
  phases?: Partial<DreamSettings["phases"]>;
  thresholds?: Partial<DreamSettings["thresholds"]>;
  caps?: Partial<DreamSettings["caps"]>;
  lossRail?: Partial<DreamSettings["lossRail"]>;
  llm?: Partial<DreamSettings["llm"]>;
}

export const DREAM_SETTINGS_DEFAULTS: Readonly<DreamSettings> = Object.freeze({
  enabled: true,
  cadenceHours: DREAM_DEFAULT_CADENCE_HOURS,
  runHourUtc: null,
  mode: "apply",
  phases: { merges: true, promotions: true, links: true, contradictions: true },
  thresholds: {
    merge: DREAM_DEFAULTS.minMergeConfidence,
    promote: DREAM_DEFAULTS.minPromoteConfidence,
    link: DREAM_DEFAULTS.minLinkConfidence,
    contradiction: DREAM_DEFAULTS.minContradictionConfidence,
  },
  caps: {
    maxMerges: DREAM_DEFAULTS.maxMerges,
    maxPromotions: DREAM_DEFAULTS.maxPromotions,
    maxLinks: DREAM_DEFAULTS.maxLinks,
    maxContradictions: DREAM_DEFAULTS.maxContradictions,
  },
  lossRail: {
    maxTouchFraction: DREAM_DEFAULTS.maxTouchFraction,
    minTouchAllowance: DREAM_DEFAULTS.minTouchAllowance,
  },
  llm: { provider: "auto", model: null },
}) as Readonly<DreamSettings>;

/** Inclusive [min, max] for every numeric setting (contracts mirrors these). */
export const DREAM_SETTINGS_BOUNDS = Object.freeze({
  cadenceHours: [DREAM_MIN_CADENCE_HOURS, DREAM_MAX_CADENCE_HOURS],
  runHourUtc: [0, 23],
  threshold: [0.5, 1],
  maxMerges: [1, 20],
  maxPromotions: [1, 20],
  maxLinks: [1, 50],
  maxContradictions: [1, 10],
  // The loss rail can only be tightened: the defaults are the upper bounds.
  maxTouchFraction: [0.01, DREAM_DEFAULTS.maxTouchFraction],
  minTouchAllowance: [0, DREAM_DEFAULTS.minTouchAllowance],
  modelLength: [1, 200],
} as const);

/** A BYOK model id: provider model names, no whitespace or markup. */
export const DREAM_MODEL_RE = /^[A-Za-z0-9._:/@-]+$/;

function clampNum(v: unknown, [lo, hi]: readonly [number, number], fallback: number, int = false): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const x = int ? Math.round(n) : n;
  return Math.min(hi, Math.max(lo, x));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Settings from anything stored (config JSON, DO meta): unknown or missing
 * fields take the default, every number is clamped into its bounds, so a
 * hand-edited config can never loosen the loss rail or exceed a cap.
 */
export function normalizeDreamSettings(input?: unknown): DreamSettings {
  const d = DREAM_SETTINGS_DEFAULTS;
  const B = DREAM_SETTINGS_BOUNDS;
  const r = rec(input);
  const ph = rec(r.phases);
  const th = rec(r.thresholds);
  const cp = rec(r.caps);
  const lr = rec(r.lossRail);
  const llm = rec(r.llm);
  const runHour = r.runHourUtc === null || r.runHourUtc === undefined
    ? null
    : clampNum(r.runHourUtc, B.runHourUtc, NaN, true);
  const model = typeof llm.model === "string" ? llm.model.trim() : "";
  return {
    enabled: bool(r.enabled, d.enabled),
    cadenceHours: clampCadenceHours(
      typeof r.cadenceHours === "number" || typeof r.cadenceHours === "string"
        ? Number(r.cadenceHours)
        : d.cadenceHours,
    ),
    runHourUtc: runHour === null || Number.isNaN(runHour) ? null : runHour,
    mode: (DREAM_MODES as readonly unknown[]).includes(r.mode) ? (r.mode as DreamMode) : d.mode,
    phases: {
      merges: bool(ph.merges, d.phases.merges),
      promotions: bool(ph.promotions, d.phases.promotions),
      links: bool(ph.links, d.phases.links),
      contradictions: bool(ph.contradictions, d.phases.contradictions),
    },
    thresholds: {
      merge: clampNum(th.merge, B.threshold, d.thresholds.merge),
      promote: clampNum(th.promote, B.threshold, d.thresholds.promote),
      link: clampNum(th.link, B.threshold, d.thresholds.link),
      contradiction: clampNum(th.contradiction, B.threshold, d.thresholds.contradiction),
    },
    caps: {
      maxMerges: clampNum(cp.maxMerges, B.maxMerges, d.caps.maxMerges, true),
      maxPromotions: clampNum(cp.maxPromotions, B.maxPromotions, d.caps.maxPromotions, true),
      maxLinks: clampNum(cp.maxLinks, B.maxLinks, d.caps.maxLinks, true),
      maxContradictions: clampNum(cp.maxContradictions, B.maxContradictions, d.caps.maxContradictions, true),
    },
    lossRail: {
      maxTouchFraction: clampNum(lr.maxTouchFraction, B.maxTouchFraction, d.lossRail.maxTouchFraction),
      minTouchAllowance: clampNum(lr.minTouchAllowance, B.minTouchAllowance, d.lossRail.minTouchAllowance, true),
    },
    llm: {
      provider: (DREAM_LLM_PROVIDERS as readonly unknown[]).includes(llm.provider)
        ? (llm.provider as DreamLlmProvider)
        : d.llm.provider,
      model:
        model && model.length <= B.modelLength[1] && DREAM_MODEL_RE.test(model) ? model : null,
    },
  };
}

/** Merge a patch into settings (nested objects field by field), then normalize. */
export function patchDreamSettings(current: DreamSettings, patch: DreamSettingsPatch): DreamSettings {
  const defined = <T extends object>(o: T | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
  const top = defined(patch);
  return normalizeDreamSettings({
    ...current,
    ...top,
    phases: { ...current.phases, ...defined(patch.phases) },
    thresholds: { ...current.thresholds, ...defined(patch.thresholds) },
    caps: { ...current.caps, ...defined(patch.caps) },
    lossRail: { ...current.lossRail, ...defined(patch.lossRail) },
    llm: { ...current.llm, ...defined(patch.llm) },
  });
}

/** The engine options a vault's settings imply (the rest stay at their defaults). */
export function dreamOptionsFromSettings(s: DreamSettings): Partial<DreamOptions> {
  return {
    phases: { ...s.phases },
    minMergeConfidence: s.thresholds.merge,
    minPromoteConfidence: s.thresholds.promote,
    minLinkConfidence: s.thresholds.link,
    minContradictionConfidence: s.thresholds.contradiction,
    maxMerges: s.caps.maxMerges,
    maxPromotions: s.caps.maxPromotions,
    maxLinks: s.caps.maxLinks,
    maxContradictions: s.caps.maxContradictions,
    // Hard floor: never looser than the default rail, whatever was stored.
    maxTouchFraction: Math.min(s.lossRail.maxTouchFraction, DREAM_DEFAULTS.maxTouchFraction),
    minTouchAllowance: Math.min(s.lossRail.minTouchAllowance, DREAM_DEFAULTS.minTouchAllowance),
  };
}

/**
 * When the next sweep is due (epoch ms): one cadence after `lastMs` (or `nowMs`
 * when never dreamed), pushed forward to the first `runHourUtc:00Z` at/after
 * that time when a run hour is set and the cadence is at least a day.
 */
export function nextDreamDue(
  lastMs: number | null,
  nowMs: number,
  s: Pick<DreamSettings, "cadenceHours" | "runHourUtc">,
): number {
  const base = lastMs !== null && Number.isFinite(lastMs) ? lastMs : nowMs;
  const due = base + clampCadenceHours(s.cadenceHours) * 3_600_000;
  if (s.runHourUtc === null || s.cadenceHours < 24) return due;
  const d = new Date(due);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), s.runHourUtc);
  return at >= due ? at : at + 24 * 3_600_000;
}
