/**
 * Burndown: task history events, backfill and metrics (SPEC.md "Burndown").
 *
 * Pure and Workers-safe: no clock reads (callers pass `now`), no fs, no
 * node-only APIs. Both backends (core's append-only log, the VaultDO's
 * `task_event` table) record events with {@link diffTaskEvents} and read
 * metrics with {@link computeBurndown}.
 */
import type { Edge, TaskStatus } from "./types.js";

// ------------------------------------------------------------------- events

export const TASK_EVENT_KINDS = [
  "created",
  "taken",
  "released",
  "done",
  "reopened",
  "scope_added",
  "scope_removed",
  "estimated",
  "deleted",
] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/** One time-stamped task transition. */
export interface TaskEvent {
  /** ISO timestamp. */
  at: string;
  /** Task concept id. */
  task: string;
  kind: TaskEventKind;
  /** `taken` / `done`: the holder's label. */
  by?: string;
  /** `scope_added` / `scope_removed`: a concept id or `tag:<tag>`. */
  scope?: string;
  /** `estimated`: story points (null = cleared). */
  points?: number | null;
}

/** Relations that put a task (or a container) inside a container. */
export const MEMBERSHIP_RELATIONS: readonly string[] = ["part_of", "realizes"];

/** The burndown-relevant state of one task at one moment. */
export interface TaskSnapshot {
  id: string;
  taskStatus: TaskStatus;
  takenBy?: string;
  estimate?: number;
  /** Direct memberships: part_of/realizes targets plus `tag:<tag>` entries, sorted. */
  scopes: string[];
}

/** The concept fields burndown reads. ConceptMeta satisfies it. */
export interface BurndownConcept {
  id: string;
  title: string;
  type: string;
  tags: string[];
  taskStatus?: TaskStatus;
  takenBy?: string;
  takenAt?: string;
  doneAt?: string;
  createdAt?: string;
  updatedAt?: string;
  startDate?: string;
  endDate?: string;
  estimate?: number;
}

/**
 * Snapshot a concept for history diffing; null when it is not a task.
 * `edges` may be the whole vault's edges or just this concept's outgoing ones.
 */
export function taskSnapshot(
  meta: Pick<BurndownConcept, "id" | "type" | "tags" | "taskStatus" | "takenBy" | "estimate">,
  edges: readonly Edge[],
): TaskSnapshot | null {
  if (meta.type !== "task") return null;
  const scopes = new Set<string>();
  for (const e of edges) {
    if (e.from === meta.id && MEMBERSHIP_RELATIONS.includes(e.relation) && e.to !== meta.id) {
      scopes.add(e.to);
    }
  }
  for (const t of meta.tags) scopes.add(`tag:${t}`);
  const snap: TaskSnapshot = {
    id: meta.id,
    taskStatus: meta.taskStatus ?? "open",
    scopes: [...scopes].sort(),
  };
  if (meta.takenBy !== undefined) snap.takenBy = meta.takenBy;
  if (meta.estimate !== undefined) snap.estimate = meta.estimate;
  return snap;
}

/** The events that turn `prev` into `next` (either may be null: created / deleted). */
export function diffTaskEvents(
  prev: TaskSnapshot | null,
  next: TaskSnapshot | null,
  at: string,
): TaskEvent[] {
  if (!prev && !next) return [];
  if (prev && !next) return [{ at, task: prev.id, kind: "deleted" }];
  const n = next as TaskSnapshot;
  const task = n.id;
  const out: TaskEvent[] = [];
  const by = (label: string | undefined): { by?: string } =>
    label !== undefined ? { by: label } : {};

  if (!prev) {
    out.push({ at, task, kind: "created" });
    for (const scope of n.scopes) out.push({ at, task, kind: "scope_added", scope });
    if (n.estimate !== undefined) out.push({ at, task, kind: "estimated", points: n.estimate });
    if (n.taskStatus === "taken") out.push({ at, task, kind: "taken", ...by(n.takenBy) });
    if (n.taskStatus === "done") out.push({ at, task, kind: "done", ...by(n.takenBy) });
    return out;
  }

  // Scope and estimate first, so a "move to iteration X and finish" lands the
  // done inside the new scope.
  const before = new Set(prev.scopes);
  const after = new Set(n.scopes);
  for (const scope of n.scopes) {
    if (!before.has(scope)) out.push({ at, task, kind: "scope_added", scope });
  }
  for (const scope of prev.scopes) {
    if (!after.has(scope)) out.push({ at, task, kind: "scope_removed", scope });
  }
  if (prev.estimate !== n.estimate) {
    out.push({ at, task, kind: "estimated", points: n.estimate ?? null });
  }

  const from = prev.taskStatus;
  const to = n.taskStatus;
  if (from !== to) {
    if (to === "taken") {
      if (from === "done") out.push({ at, task, kind: "reopened" });
      out.push({ at, task, kind: "taken", ...by(n.takenBy) });
    } else if (to === "done") {
      out.push({ at, task, kind: "done", ...by(n.takenBy ?? prev.takenBy) });
    } else if (from === "done") {
      out.push({ at, task, kind: "reopened" });
    } else {
      out.push({ at, task, kind: "released" });
    }
  } else if (to === "taken" && n.takenBy !== prev.takenBy) {
    // A reclaim (stale claim handed to someone else) is a fresh take.
    out.push({ at, task, kind: "taken", ...by(n.takenBy) });
  }
  return out;
}

// ----------------------------------------------------------------- backfill

const KIND_RANK: Record<TaskEventKind, number> = {
  created: 0,
  scope_added: 1,
  estimated: 1,
  scope_removed: 2,
  taken: 2,
  released: 2,
  done: 2,
  reopened: 2,
  deleted: 3,
};

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

function iso(t: number): string {
  return new Date(t).toISOString();
}

/** Sort events by time, then created → memberships → transitions, keeping input order. */
export function sortTaskEvents(events: readonly TaskEvent[]): TaskEvent[] {
  return events
    .map((e, i) => ({ e, i, t: ms(e.at) ?? 0 }))
    .sort((a, b) => a.t - b.t || KIND_RANK[a.e.kind] - KIND_RANK[b.e.kind] || a.i - b.i)
    .map((x) => x.e);
}

interface ReplayState {
  alive: boolean;
  status: TaskStatus;
  by?: string;
  takenAt?: number;
  estimate?: number;
  scopes: Set<string>;
  lastAt: number;
}

function replayOne(events: readonly TaskEvent[]): ReplayState {
  const st: ReplayState = { alive: false, status: "open", scopes: new Set(), lastAt: -Infinity };
  for (const e of events) applyEvent(st, e);
  return st;
}

function applyEvent(st: ReplayState, e: TaskEvent): void {
  const t = ms(e.at) ?? 0;
  st.lastAt = Math.max(st.lastAt, t);
  switch (e.kind) {
    case "created":
      st.alive = true;
      break;
    case "taken":
      st.alive = true;
      st.status = "taken";
      st.by = e.by;
      st.takenAt = t;
      break;
    case "released":
    case "reopened":
      st.status = "open";
      st.by = undefined;
      st.takenAt = undefined;
      break;
    case "done":
      st.status = "done";
      if (e.by !== undefined) st.by = e.by;
      break;
    case "scope_added":
      if (e.scope) st.scopes.add(e.scope);
      break;
    case "scope_removed":
      if (e.scope) st.scopes.delete(e.scope);
      break;
    case "estimated":
      st.estimate = e.points ?? undefined;
      break;
    case "deleted":
      st.alive = false;
      break;
  }
}

/**
 * Merge the recorded log with what the current concepts prove (SPEC.md
 * "Backfill"): a missing `created`, initial memberships/estimates the log
 * never mentioned, and a reconciliation of status/scopes/estimate with the
 * frontmatter (hand edits). Idempotent; returns a new sorted list.
 * `fallbackAt` dates a task with no timestamps at all.
 */
export function backfillTaskEvents(
  concepts: readonly BurndownConcept[],
  edges: readonly Edge[],
  events: readonly TaskEvent[],
  fallbackAt = "1970-01-01T00:00:00.000Z",
): TaskEvent[] {
  const byTask = new Map<string, TaskEvent[]>();
  for (const e of sortTaskEvents(events)) {
    const list = byTask.get(e.task);
    if (list) list.push(e);
    else byTask.set(e.task, [e]);
  }
  const outgoing = new Map<string, Edge[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from);
    if (list) list.push(e);
    else outgoing.set(e.from, [e]);
  }

  const out: TaskEvent[] = [...events];
  const current = new Set<string>();
  for (const c of concepts) {
    const snap = taskSnapshot(c, outgoing.get(c.id) ?? []);
    if (!snap) continue;
    current.add(c.id);
    const log = byTask.get(c.id) ?? [];
    const add: TaskEvent[] = [];
    const task = c.id;

    // created
    let createdAt: number;
    const loggedCreated = log.find((e) => e.kind === "created");
    if (loggedCreated) {
      createdAt = ms(loggedCreated.at) ?? 0;
    } else {
      const candidates = [ms(c.createdAt), ms(log[0]?.at), ms(c.takenAt), ms(c.doneAt)].filter(
        (t): t is number => t !== undefined,
      );
      createdAt = candidates.length > 0 ? Math.min(...candidates) : (ms(fallbackAt) ?? 0);
      add.push({ at: iso(createdAt), task, kind: "created" });
    }
    const createdIso = iso(createdAt);

    // memberships / estimate the log never mentioned: present since creation
    const mentioned = new Set(log.filter((e) => e.scope).map((e) => e.scope as string));
    for (const scope of snap.scopes) {
      if (!mentioned.has(scope)) add.push({ at: createdIso, task, kind: "scope_added", scope });
    }
    if (snap.estimate !== undefined && !log.some((e) => e.kind === "estimated")) {
      add.push({ at: createdIso, task, kind: "estimated", points: snap.estimate });
    }

    // Replay what we have so far and reconcile with the frontmatter.
    const merged = sortTaskEvents([...log, ...add]);
    const st = replayOne(merged);
    const updated = ms(c.updatedAt);
    const after = (t: number | undefined): number => {
      const floor = Number.isFinite(st.lastAt) ? st.lastAt : createdAt;
      return t !== undefined && t >= floor ? t : Math.max(floor, updated ?? floor);
    };
    const reconcile: TaskEvent[] = [];
    for (const scope of snap.scopes) {
      if (!st.scopes.has(scope) && mentioned.has(scope)) {
        reconcile.push({ at: iso(after(updated)), task, kind: "scope_added", scope });
      }
    }
    for (const scope of st.scopes) {
      if (!snap.scopes.includes(scope)) {
        reconcile.push({ at: iso(after(updated)), task, kind: "scope_removed", scope });
      }
    }
    if (st.estimate !== snap.estimate && log.some((e) => e.kind === "estimated")) {
      reconcile.push({
        at: iso(after(updated)),
        task,
        kind: "estimated",
        points: snap.estimate ?? null,
      });
    }
    const want = snap.taskStatus;
    if (want !== st.status || (want === "taken" && snap.takenBy !== st.by && snap.takenBy)) {
      if (want === "taken") {
        if (st.status === "done") reconcile.push({ at: iso(after(ms(c.takenAt))), task, kind: "reopened" });
        reconcile.push({
          at: iso(after(ms(c.takenAt))),
          task,
          kind: "taken",
          ...(snap.takenBy !== undefined ? { by: snap.takenBy } : {}),
        });
      } else if (want === "done") {
        // A done task with a claim we never saw: record the claim first so
        // cycle time has a start.
        if (st.status === "open" && c.takenAt && !log.some((e) => e.kind === "taken")) {
          const takenT = after(ms(c.takenAt));
          reconcile.push({
            at: iso(takenT),
            task,
            kind: "taken",
            ...(c.takenBy !== undefined ? { by: c.takenBy } : {}),
          });
          st.lastAt = Math.max(st.lastAt, takenT);
        }
        reconcile.push({
          at: iso(after(ms(c.doneAt))),
          task,
          kind: "done",
          ...((snap.takenBy ?? st.by) !== undefined ? { by: (snap.takenBy ?? st.by) as string } : {}),
        });
      } else {
        reconcile.push({
          at: iso(after(updated)),
          task,
          kind: st.status === "done" ? "reopened" : "released",
        });
      }
    }
    out.push(...add, ...reconcile);
  }

  // Tasks the log knows that are gone now (deleted by hand): close them.
  for (const [task, log] of byTask) {
    if (current.has(task)) continue;
    const st = replayOne(log);
    if (st.alive) out.push({ at: iso(st.lastAt), task, kind: "deleted" });
  }
  return sortTaskEvents(out);
}

// ------------------------------------------------------------------ metrics

export const BURNDOWN_METRICS = [
  "series",
  "scopeChanges",
  "velocity",
  "projection",
  "cycle",
  "agents",
  "stale",
] as const;
export type BurndownMetric = (typeof BURNDOWN_METRICS)[number];
export type BurndownBucket = "day" | "week";
export type BurndownUnit = "tasks" | "points";

export const BURNDOWN_DEFAULT_STALE_HOURS = 24;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

export interface BurndownOptions {
  /** Scope: a concept id, `tag:<tag>`, or omitted for the whole vault. */
  scope?: string;
  /** Window start (ISO date or timestamp). */
  from?: string;
  /** Window end (ISO date or timestamp). */
  to?: string;
  bucket?: BurndownBucket;
  unit?: BurndownUnit;
  staleAfterHours?: number;
  metrics?: readonly BurndownMetric[];
}

export interface BurndownInput extends BurndownOptions {
  concepts: readonly BurndownConcept[];
  edges: readonly Edge[];
  events: readonly TaskEvent[];
  now: string | Date;
}

export interface BurndownStats {
  count: number;
  median: number | null;
  p85: number | null;
  mean: number | null;
}

export interface BurndownResult {
  scope: {
    id: string | null;
    kind: "vault" | "concept" | "tag";
    title: string;
    type?: string;
    startDate?: string;
    endDate?: string;
  };
  window: { from: string; to: string; now: string; bucket: BurndownBucket; unit: BurndownUnit };
  totals: { scope: number; done: number; open: number; taken: number; unestimated: number };
  series?: {
    at: string;
    scope: number | null;
    done: number | null;
    open: number | null;
    taken: number | null;
    ideal: number | null;
  }[];
  scopeChanges?: {
    at: string;
    task: string;
    title: string;
    change: "added" | "removed";
    points: number | null;
  }[];
  velocity?: {
    by: "iteration" | "week";
    periods: { label: string; id?: string; from: string; to: string; done: number; complete: boolean }[];
    average: number | null;
  };
  projection?: {
    remaining: number;
    ratePerWeek: { mean: number; stdev: number };
    samples: number;
    likely: string | null;
    optimistic: string | null;
    pessimistic: string | null;
    onTrack: boolean | null;
    reason?: string;
  };
  cycle?: {
    leadHours: BurndownStats;
    cycleHours: BurndownStats;
    byAgent: { agent: string; leadHours: BurndownStats; cycleHours: BurndownStats }[];
  };
  agents?: {
    agent: string;
    held: number;
    done: number;
    medianLeadHours: number | null;
    medianCycleHours: number | null;
    stale: number;
  }[];
  stale?: { id: string; title: string; takenBy: string | null; takenAt: string; ageHours: number }[];
}

/** Thrown for a scope id that names no concept. */
export class UnknownScopeError extends Error {
  constructor(scope: string) {
    super(`unknown burndown scope: "${scope}"`);
    this.name = "UnknownScopeError";
  }
}

/** Thrown for a malformed window (bad dates, from >= to). */
export class BurndownInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BurndownInputError";
  }
}

/** Per-task timeline built from the sorted events. */
interface Timeline {
  id: string;
  events: TaskEvent[];
  times: number[];
}

/** Replay a task's events up to and including time `t`. */
function stateAt(tl: Timeline, t: number): ReplayState {
  const st: ReplayState = { alive: false, status: "open", scopes: new Set(), lastAt: -Infinity };
  for (let i = 0; i < tl.events.length && tl.times[i] <= t; i++) applyEvent(st, tl.events[i]);
  return st;
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function parseBound(value: string, name: string): number {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayStart(value) : Date.parse(value);
  if (Number.isNaN(t)) throw new BurndownInputError(`invalid ${name}: ${JSON.stringify(value)}`);
  return t;
}

function floorDay(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

/** Monday 00:00 UTC of t's ISO week. */
function floorWeek(t: number): number {
  const d = floorDay(t);
  const dow = (new Date(d).getUTCDay() + 6) % 7; // Monday = 0
  return d - dow * DAY;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function stats(values: number[]): BurndownStats {
  if (values.length === 0) return { count: 0, median: null, p85: null, mean: null };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number): number => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return {
    count: s.length,
    median: round(q(0.5), 1),
    p85: round(q(0.85), 1),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length, 1),
  };
}

/**
 * The scope's closure: the scope plus every concept with a part_of/realizes
 * edge into it, transitively (cycle-safe, at most 6 hops).
 */
export function scopeClosure(scope: string, edges: readonly Edge[]): Set<string> {
  const inbound = new Map<string, string[]>();
  for (const e of edges) {
    if (!MEMBERSHIP_RELATIONS.includes(e.relation)) continue;
    const list = inbound.get(e.to);
    if (list) list.push(e.from);
    else inbound.set(e.to, [e.from]);
  }
  const seen = new Set<string>([scope]);
  let frontier = [scope];
  for (let hop = 0; hop < 6 && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const from of inbound.get(id) ?? []) {
        if (!seen.has(from)) {
          seen.add(from);
          next.push(from);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Compute burndown metrics for one scope and window (SPEC.md "Metrics"). */
export function computeBurndown(input: BurndownInput): BurndownResult {
  const nowMs = typeof input.now === "string" ? Date.parse(input.now) : input.now.getTime();
  if (Number.isNaN(nowMs)) throw new BurndownInputError("invalid now");
  const byId = new Map(input.concepts.map((c) => [c.id, c]));
  const wanted = new Set<BurndownMetric>(input.metrics ?? BURNDOWN_METRICS);
  const unit: BurndownUnit = input.unit ?? "tasks";

  // ---- scope
  let scopeInfo: BurndownResult["scope"];
  let keys: Set<string> | null = null; // null = whole vault
  let scopeConcept: BurndownConcept | undefined;
  if (input.scope === undefined || input.scope === "") {
    scopeInfo = { id: null, kind: "vault", title: "All tasks" };
  } else if (input.scope.startsWith("tag:")) {
    const tag = input.scope.slice(4);
    if (!tag) throw new BurndownInputError("empty tag scope");
    keys = new Set([input.scope]);
    scopeInfo = { id: input.scope, kind: "tag", title: `#${tag}` };
  } else {
    scopeConcept = byId.get(input.scope);
    if (!scopeConcept) throw new UnknownScopeError(input.scope);
    keys = scopeClosure(input.scope, input.edges);
    scopeInfo = {
      id: scopeConcept.id,
      kind: "concept",
      title: scopeConcept.title,
      type: scopeConcept.type,
      ...(scopeConcept.startDate ? { startDate: scopeConcept.startDate } : {}),
      ...(scopeConcept.endDate ? { endDate: scopeConcept.endDate } : {}),
    };
  }
  const scopeStart = scopeConcept?.startDate ? dayStart(scopeConcept.startDate) : undefined;
  const scopeEnd = scopeConcept?.endDate ? dayStart(scopeConcept.endDate) + DAY : undefined;

  // ---- window
  const fromMs = input.from ? parseBound(input.from, "from") : (scopeStart ?? nowMs - 8 * WEEK);
  const toMs = input.to
    ? parseBound(input.to, "to")
    : Math.max(scopeEnd ?? nowMs, nowMs);
  if (!(fromMs < toMs)) throw new BurndownInputError("`from` must be before `to`");
  const bucket: BurndownBucket = input.bucket ?? (toMs - fromMs <= 120 * DAY ? "day" : "week");
  const staleHours = input.staleAfterHours ?? BURNDOWN_DEFAULT_STALE_HOURS;

  // ---- history
  const events = backfillTaskEvents(input.concepts, input.edges, input.events, iso(fromMs));
  const timelines = new Map<string, Timeline>();
  for (const e of events) {
    let tl = timelines.get(e.task);
    if (!tl) {
      tl = { id: e.task, events: [], times: [] };
      timelines.set(e.task, tl);
    }
    tl.events.push(e);
    tl.times.push(ms(e.at) ?? 0);
  }
  const all = [...timelines.values()];

  const inScope = (st: ReplayState): boolean => {
    if (!st.alive) return false;
    if (!keys) return true;
    for (const s of st.scopes) if (keys.has(s)) return true;
    return false;
  };
  const amount = (st: ReplayState): number => (unit === "points" ? (st.estimate ?? 0) : 1);
  const titleOf = (id: string): string => byId.get(id)?.title ?? id;

  // Membership transitions per task: [{t, in}] at every event time.
  const transitions = new Map<string, { t: number; in: boolean }[]>();
  for (const tl of all) {
    const st: ReplayState = { alive: false, status: "open", scopes: new Set(), lastAt: -Infinity };
    let was = false;
    const list: { t: number; in: boolean }[] = [];
    for (let i = 0; i < tl.events.length; i++) {
      applyEvent(st, tl.events[i]);
      // evaluate after the last event at this instant
      if (i + 1 < tl.events.length && tl.times[i + 1] === tl.times[i]) continue;
      const now = inScope(st);
      if (now !== was) list.push({ t: tl.times[i], in: now });
      was = now;
    }
    transitions.set(tl.id, list);
  }
  const relevant = all.filter((tl) => (transitions.get(tl.id) ?? []).length > 0);

  const snapshotAt = (t: number) => {
    let scope = 0;
    let done = 0;
    let taken = 0;
    let unestimated = 0;
    for (const tl of relevant) {
      const st = stateAt(tl, t);
      if (!inScope(st)) continue;
      const a = amount(st);
      scope += a;
      if (st.status === "done") done += a;
      if (st.status === "taken") taken += a;
      if (st.estimate === undefined) unestimated += 1;
    }
    return { scope: round(scope), done: round(done), taken: round(taken), open: round(scope - done), unestimated };
  };

  const nowSnap = snapshotAt(nowMs);
  const result: BurndownResult = {
    scope: scopeInfo,
    window: { from: iso(fromMs), to: iso(toMs), now: iso(nowMs), bucket, unit },
    totals: {
      scope: nowSnap.scope,
      done: nowSnap.done,
      open: nowSnap.open,
      taken: nowSnap.taken,
      unestimated: nowSnap.unestimated,
    },
  };

  // Net done amount in [a, b): done transitions minus reopen-from-done.
  const doneBetween = (a: number, b: number): number => {
    let total = 0;
    for (const tl of relevant) {
      const st: ReplayState = { alive: false, status: "open", scopes: new Set(), lastAt: -Infinity };
      for (let i = 0; i < tl.events.length; i++) {
        const e = tl.events[i];
        const t = tl.times[i];
        if (t >= b) break;
        const wasDone = st.status === "done";
        applyEvent(st, e);
        if (t < a) continue;
        if (e.kind === "done" && !wasDone && inScope(st)) total += amount(st);
        if (e.kind === "reopened" && wasDone && inScope(st)) total -= amount(st);
      }
    }
    return round(total);
  };

  // ---- series + ideal
  if (wanted.has("series")) {
    const points: number[] = [fromMs];
    const step = (t: number): number =>
      bucket === "day" ? floorDay(t) + DAY : floorWeek(t) + WEEK;
    for (let t = step(fromMs); t < toMs; t = step(t)) points.push(t);
    points.push(toMs);
    // Insert `now` so the actual line ends exactly at now.
    if (nowMs > fromMs && nowMs < toMs && !points.includes(nowMs)) points.push(nowMs);
    points.sort((a, b) => a - b);
    // The ideal runs from the remaining amount at the scope's start to 0 at
    // its end. When the scope was still empty at its start (work planned in
    // after day one), it anchors at the first moment the scope has work.
    let idealStartRemaining: number | null = null;
    let idealFrom = scopeStart;
    if (scopeStart !== undefined && scopeEnd !== undefined && scopeEnd > scopeStart) {
      idealStartRemaining = snapshotAt(Math.min(scopeStart, nowMs)).open;
      if (idealStartRemaining === 0) {
        const limit = Math.min(scopeEnd, nowMs);
        let first = Infinity;
        for (const tl of relevant) {
          for (const tr of transitions.get(tl.id) ?? []) {
            if (tr.in && tr.t >= scopeStart && tr.t < limit) first = Math.min(first, tr.t);
          }
        }
        if (Number.isFinite(first)) {
          idealFrom = first;
          idealStartRemaining = snapshotAt(first).open;
        }
      }
    }
    if (
      idealFrom !== undefined &&
      idealFrom !== scopeStart &&
      idealFrom > fromMs &&
      idealFrom < toMs &&
      !points.includes(idealFrom)
    ) {
      points.push(idealFrom);
      points.sort((a, b) => a - b);
    }
    result.series = points.map((t) => {
      let ideal: number | null = null;
      if (idealStartRemaining !== null && idealFrom !== undefined && scopeEnd !== undefined) {
        if (t >= idealFrom && t <= scopeEnd) {
          ideal = round(idealStartRemaining * (1 - (t - idealFrom) / (scopeEnd - idealFrom)));
        }
      }
      if (t > nowMs) return { at: iso(t), scope: null, done: null, open: null, taken: null, ideal };
      const s = snapshotAt(t);
      return { at: iso(t), scope: s.scope, done: s.done, open: s.open, taken: s.taken, ideal };
    });
  }

  // ---- scope changes
  if (wanted.has("scopeChanges")) {
    const changes: NonNullable<BurndownResult["scopeChanges"]> = [];
    for (const tl of relevant) {
      for (const tr of transitions.get(tl.id) ?? []) {
        if (tr.t <= fromMs || tr.t > Math.min(toMs, nowMs)) continue;
        const st = stateAt(tl, tr.in ? tr.t : tr.t - 1);
        changes.push({
          at: iso(tr.t),
          task: tl.id,
          title: titleOf(tl.id),
          change: tr.in ? "added" : "removed",
          points: st.estimate ?? null,
        });
      }
    }
    changes.sort((a, b) => a.at.localeCompare(b.at) || a.task.localeCompare(b.task));
    result.scopeChanges = changes;
  }

  // ---- velocity
  if (wanted.has("velocity")) {
    const iterations = [...(keys ?? [])]
      .map((id) => byId.get(id))
      .filter(
        (c): c is BurndownConcept =>
          !!c && c.type === "iteration" && c.id !== scopeConcept?.id && !!c.startDate && !!c.endDate,
      )
      .sort((a, b) => (a.startDate as string).localeCompare(b.startDate as string));
    const periods: NonNullable<BurndownResult["velocity"]>["periods"] = [];
    let by: "iteration" | "week";
    if (iterations.length > 0) {
      by = "iteration";
      for (const it of iterations) {
        const a = dayStart(it.startDate as string);
        const b = dayStart(it.endDate as string) + DAY;
        if (a > nowMs) continue;
        periods.push({
          label: it.title,
          id: it.id,
          from: iso(a),
          to: iso(b),
          done: doneBetween(a, Math.min(b, nowMs + 1)),
          complete: b <= nowMs,
        });
      }
    } else {
      by = "week";
      const end = Math.min(toMs, nowMs);
      for (let a = floorWeek(fromMs); a < end; a += WEEK) {
        const b = a + WEEK;
        periods.push({
          label: iso(a).slice(0, 10),
          from: iso(a),
          to: iso(b),
          done: doneBetween(a, Math.min(b, nowMs + 1)),
          complete: b <= nowMs,
        });
      }
    }
    const complete = periods.filter((p) => p.complete);
    const basis = complete.length > 0 ? complete : periods;
    result.velocity = {
      by,
      periods,
      average:
        basis.length > 0 ? round(basis.reduce((s, p) => s + p.done, 0) / basis.length) : null,
    };
  }

  // ---- projection
  if (wanted.has("projection")) {
    const remaining = nowSnap.open;
    let earliest = Infinity;
    for (const tl of relevant) {
      const first = (transitions.get(tl.id) ?? []).find((tr) => tr.in);
      if (first) earliest = Math.min(earliest, first.t);
    }
    const age = Number.isFinite(earliest) ? nowMs - earliest : 0;
    const samples = Math.min(6, Math.max(1, Math.ceil(age / WEEK)));
    const rates: number[] = [];
    for (let i = 0; i < samples; i++) {
      rates.push(doneBetween(nowMs - (i + 1) * WEEK, nowMs - i * WEEK + 1));
    }
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const stdev = Math.sqrt(rates.reduce((a, r) => a + (r - mean) ** 2, 0) / rates.length);
    const at = (rate: number): string | null =>
      rate > 0 ? iso(nowMs + (remaining / rate) * WEEK) : null;
    let likely: string | null;
    let optimistic: string | null;
    let pessimistic: string | null;
    let reason: string | undefined;
    if (relevant.length === 0) {
      likely = optimistic = pessimistic = null;
      reason = "no tasks in scope";
    } else if (remaining <= 0) {
      let last = -Infinity;
      for (const tl of relevant) {
        tl.events.forEach((e, i) => {
          if (e.kind === "done" && tl.times[i] <= nowMs) last = Math.max(last, tl.times[i]);
        });
      }
      likely = optimistic = pessimistic = Number.isFinite(last) ? iso(last) : null;
      reason = "nothing remaining";
    } else {
      likely = at(mean);
      optimistic = at(mean + stdev);
      pessimistic = at(mean - stdev);
      if (likely === null) reason = `no work finished in the last ${samples} week${samples === 1 ? "" : "s"}`;
      else if (pessimistic === null) reason = "throughput too uneven for a pessimistic bound";
    }
    result.projection = {
      remaining,
      ratePerWeek: { mean: round(mean), stdev: round(stdev) },
      samples,
      likely,
      optimistic,
      pessimistic,
      onTrack:
        scopeEnd !== undefined && likely !== null && remaining > 0
          ? Date.parse(likely) <= scopeEnd
          : scopeEnd !== undefined && remaining <= 0 && relevant.length > 0
            ? true
            : null,
      ...(reason ? { reason } : {}),
    };
  }

  // ---- cycle / agents / stale
  const finished: { agent: string; lead: number; cycle: number | null }[] = [];
  if (wanted.has("cycle") || wanted.has("agents")) {
    const end = Math.min(toMs, nowMs);
    for (const tl of relevant) {
      let created: number | undefined;
      let lastTaken: number | undefined;
      let hit: { agent: string; lead: number; cycle: number | null } | undefined;
      const st: ReplayState = { alive: false, status: "open", scopes: new Set(), lastAt: -Infinity };
      for (let i = 0; i < tl.events.length; i++) {
        const e = tl.events[i];
        const t = tl.times[i];
        if (t > end) break;
        applyEvent(st, e);
        if (e.kind === "created" && created === undefined) created = t;
        if (e.kind === "taken") lastTaken = t;
        if (e.kind === "reopened" || e.kind === "released") lastTaken = undefined;
        if (e.kind === "done" && t >= fromMs && inScope(st) && created !== undefined) {
          hit = {
            agent: e.by ?? "unassigned",
            lead: (t - created) / 3_600_000,
            cycle: lastTaken !== undefined ? (t - lastTaken) / 3_600_000 : null,
          };
        }
        if (e.kind === "reopened") hit = undefined;
      }
      if (hit) finished.push(hit);
    }
  }
  if (wanted.has("cycle")) {
    const agents = [...new Set(finished.map((f) => f.agent))].sort();
    result.cycle = {
      leadHours: stats(finished.map((f) => f.lead)),
      cycleHours: stats(finished.flatMap((f) => (f.cycle !== null ? [f.cycle] : []))),
      byAgent: agents.map((agent) => {
        const mine = finished.filter((f) => f.agent === agent);
        return {
          agent,
          leadHours: stats(mine.map((f) => f.lead)),
          cycleHours: stats(mine.flatMap((f) => (f.cycle !== null ? [f.cycle] : []))),
        };
      }),
    };
  }

  const held: { id: string; by: string | null; takenAt: number }[] = [];
  for (const tl of relevant) {
    const st = stateAt(tl, nowMs);
    if (inScope(st) && st.status === "taken" && st.takenAt !== undefined) {
      held.push({ id: tl.id, by: st.by ?? null, takenAt: st.takenAt });
    }
  }
  const staleList = held
    .filter((h) => nowMs - h.takenAt >= staleHours * 3_600_000)
    .sort((a, b) => a.takenAt - b.takenAt || a.id.localeCompare(b.id));
  if (wanted.has("stale")) {
    result.stale = staleList.map((h) => ({
      id: h.id,
      title: titleOf(h.id),
      takenBy: h.by,
      takenAt: iso(h.takenAt),
      ageHours: round((nowMs - h.takenAt) / 3_600_000, 1),
    }));
  }
  if (wanted.has("agents")) {
    const label = (b: string | null): string => b ?? "unassigned";
    const names = new Set<string>([...held.map((h) => label(h.by)), ...finished.map((f) => f.agent)]);
    result.agents = [...names].sort().map((agent) => {
      const mine = finished.filter((f) => f.agent === agent);
      return {
        agent,
        held: held.filter((h) => label(h.by) === agent).length,
        done: mine.length,
        medianLeadHours: stats(mine.map((f) => f.lead)).median,
        medianCycleHours: stats(mine.flatMap((f) => (f.cycle !== null ? [f.cycle] : []))).median,
        stale: staleList.filter((h) => label(h.by) === agent).length,
      };
    });
  }
  return result;
}
