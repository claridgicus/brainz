import { describe, expect, it } from "vitest";
import {
  UnknownScopeError,
  backfillTaskEvents,
  computeBurndown,
  diffTaskEvents,
  scopeClosure,
  taskSnapshot,
  type BurndownConcept,
  type TaskEvent,
} from "../src/burndown.js";
import { normalizeDay, normalizeEstimate, parseNote } from "../src/note.js";
import type { Edge } from "../src/types.js";

const D = (day: string, hour = 12): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000).toISOString();

function task(id: string, extra: Partial<BurndownConcept> = {}): BurndownConcept {
  return { id, title: id.toUpperCase(), type: "task", tags: [], ...extra };
}

describe("note fields", () => {
  it("parses start/end dates and estimates", () => {
    const { meta } = parseNote(
      "---\nid: s1\ntype: iteration\nstart_date: 2026-11-02\nend_date: '2026-11-13T09:00:00Z'\nestimate: '3'\n---\nbody\n",
      { fallbackId: "s1" },
    );
    expect(meta.type).toBe("iteration");
    expect(meta.startDate).toBe("2026-11-02");
    expect(meta.endDate).toBe("2026-11-13");
    expect(meta.estimate).toBe(3);
  });
  it("drops junk", () => {
    expect(normalizeDay("soon")).toBeUndefined();
    expect(normalizeDay(new Date("2026-01-05T23:00:00Z"))).toBe("2026-01-05");
    expect(normalizeEstimate(-1)).toBeUndefined();
    expect(normalizeEstimate("x")).toBeUndefined();
    expect(normalizeEstimate(0)).toBe(0);
    const { meta } = parseNote("---\ntype: milestone\n---\n", { fallbackId: "m" });
    expect(meta.type).toBe("milestone");
  });
});

describe("diffTaskEvents", () => {
  const at = "2026-11-01T00:00:00.000Z";
  const base = { id: "t", taskStatus: "open" as const, scopes: ["dom"] };

  it("records creation with scopes, estimate and status", () => {
    expect(
      diffTaskEvents(null, { ...base, taskStatus: "taken", takenBy: "a", estimate: 2 }, at).map(
        (e) => e.kind,
      ),
    ).toEqual(["created", "scope_added", "estimated", "taken"]);
  });
  it("covers each transition", () => {
    const k = (p: object, n: object) =>
      diffTaskEvents({ ...base, ...p }, { ...base, ...n }, at).map((e) => e.kind);
    expect(k({}, { taskStatus: "taken", takenBy: "a" })).toEqual(["taken"]);
    expect(k({ taskStatus: "taken", takenBy: "a" }, {})).toEqual(["released"]);
    expect(k({ taskStatus: "taken", takenBy: "a" }, { taskStatus: "done", takenBy: "a" })).toEqual([
      "done",
    ]);
    expect(k({}, { taskStatus: "done" })).toEqual(["done"]);
    expect(k({ taskStatus: "done" }, {})).toEqual(["reopened"]);
    expect(k({ taskStatus: "done" }, { taskStatus: "taken", takenBy: "b" })).toEqual([
      "reopened",
      "taken",
    ]);
    expect(k({ taskStatus: "taken", takenBy: "a" }, { taskStatus: "taken", takenBy: "b" })).toEqual(
      ["taken"],
    );
    expect(k({ scopes: ["dom", "s1"] }, { scopes: ["dom", "s2"], estimate: 5 })).toEqual([
      "scope_added",
      "scope_removed",
      "estimated",
    ]);
    expect(diffTaskEvents({ ...base }, null, at)).toEqual([{ at, task: "t", kind: "deleted" }]);
    expect(k({}, {})).toEqual([]);
  });
  it("snapshots memberships from edges and tags", () => {
    const edges: Edge[] = [
      { from: "t", to: "s1", relation: "part_of" },
      { from: "t", to: "f", relation: "realizes" },
      { from: "t", to: "x", relation: "related_to" },
      { from: "o", to: "s1", relation: "part_of" },
    ];
    expect(taskSnapshot({ id: "t", type: "task", tags: ["p1"] }, edges)?.scopes).toEqual([
      "f",
      "s1",
      "tag:p1",
    ]);
    expect(taskSnapshot({ id: "c", type: "feature", tags: [] }, edges)).toBeNull();
  });
});

describe("backfillTaskEvents", () => {
  const edges: Edge[] = [{ from: "a", to: "dom", relation: "part_of" }];
  const concepts = [
    task("a", {
      createdAt: D("2026-10-01"),
      taskStatus: "done",
      takenBy: "w1",
      takenAt: D("2026-10-02"),
      doneAt: D("2026-10-03"),
      estimate: 3,
    }),
  ];

  it("derives a full history from frontmatter", () => {
    const ev = backfillTaskEvents(concepts, edges, []);
    expect(ev.map((e) => [e.kind, e.at])).toEqual([
      ["created", D("2026-10-01")],
      ["scope_added", D("2026-10-01")],
      ["estimated", D("2026-10-01")],
      ["taken", D("2026-10-02")],
      ["done", D("2026-10-03")],
    ]);
    expect(ev.find((e) => e.kind === "done")?.by).toBe("w1");
  });

  it("is idempotent over its own output", () => {
    const once = backfillTaskEvents(concepts, edges, []);
    expect(backfillTaskEvents(concepts, edges, once)).toEqual(once);
  });

  it("keeps the live log and fills only the gaps", () => {
    const log: TaskEvent[] = [
      { at: D("2026-10-02"), task: "a", kind: "taken", by: "w1" },
      { at: D("2026-10-03"), task: "a", kind: "done", by: "w1" },
    ];
    const ev = backfillTaskEvents(concepts, edges, log);
    expect(ev.filter((e) => e.kind === "done")).toHaveLength(1);
    expect(ev[0].kind).toBe("created");
  });

  it("reconciles hand edits and hand deletions", () => {
    const log: TaskEvent[] = [
      { at: D("2026-10-01"), task: "a", kind: "created" },
      { at: D("2026-10-01"), task: "a", kind: "scope_added", scope: "old" },
      { at: D("2026-10-01"), task: "gone", kind: "created" },
    ];
    const ev = backfillTaskEvents(
      [task("a", { createdAt: D("2026-10-01"), updatedAt: D("2026-10-05") })],
      edges,
      log,
    );
    expect(ev.some((e) => e.kind === "scope_removed" && e.scope === "old")).toBe(true);
    expect(ev.some((e) => e.kind === "scope_added" && e.scope === "dom")).toBe(true);
    expect(ev.some((e) => e.task === "gone" && e.kind === "deleted")).toBe(true);
  });
});

describe("computeBurndown", () => {
  // Iteration s1 (Nov 2–13) under milestone m1; four tasks.
  const concepts: BurndownConcept[] = [
    { id: "m1", title: "Milestone 1", type: "milestone", tags: [], endDate: "2026-11-30" },
    {
      id: "s1",
      title: "Sprint 1",
      type: "iteration",
      tags: [],
      startDate: "2026-11-02",
      endDate: "2026-11-13",
    },
    task("t1", { estimate: 2 }),
    task("t2", { estimate: 3 }),
    task("t3", { estimate: 5, tags: ["p1"] }),
    task("t4"),
  ];
  const edges: Edge[] = [
    { from: "s1", to: "m1", relation: "part_of" },
    { from: "t1", to: "s1", relation: "part_of" },
    { from: "t2", to: "s1", relation: "part_of" },
    { from: "t3", to: "s1", relation: "part_of" },
    { from: "t4", to: "m1", relation: "part_of" },
  ];
  const created = (t: string, day: string): TaskEvent[] => [
    { at: D(day, 9), task: t, kind: "created" },
  ];
  const events: TaskEvent[] = [
    ...created("t1", "2026-11-02"),
    { at: D("2026-11-02", 9), task: "t1", kind: "scope_added", scope: "s1" },
    { at: D("2026-11-02", 9), task: "t1", kind: "estimated", points: 2 },
    ...created("t2", "2026-11-02"),
    { at: D("2026-11-02", 9), task: "t2", kind: "scope_added", scope: "s1" },
    { at: D("2026-11-02", 9), task: "t2", kind: "estimated", points: 3 },
    ...created("t3", "2026-11-02"),
    { at: D("2026-11-02", 9), task: "t3", kind: "scope_added", scope: "s1" },
    { at: D("2026-11-02", 9), task: "t3", kind: "scope_added", scope: "tag:p1" },
    { at: D("2026-11-02", 9), task: "t3", kind: "estimated", points: 5 },
    { at: D("2026-11-03", 10), task: "t1", kind: "taken", by: "agent-a" },
    { at: D("2026-11-04", 10), task: "t1", kind: "done", by: "agent-a" },
    { at: D("2026-11-04", 11), task: "t2", kind: "taken", by: "agent-b" },
    // t4 added to the milestone mid-sprint
    ...created("t4", "2026-11-05"),
    { at: D("2026-11-05", 9), task: "t4", kind: "scope_added", scope: "m1" },
    { at: D("2026-11-06", 9), task: "t3", kind: "taken", by: "agent-a" },
    { at: D("2026-11-07", 9), task: "t3", kind: "done", by: "agent-a" },
  ];
  // Make the concepts' current state agree with the log.
  const live = concepts.map((c) =>
    c.id === "t1" || c.id === "t3"
      ? { ...c, taskStatus: "done" as const, takenBy: "agent-a" }
      : c.id === "t2"
        ? { ...c, taskStatus: "taken" as const, takenBy: "agent-b" }
        : c,
  );
  const now = D("2026-11-08", 12);

  it("burns down an iteration with an ideal line", () => {
    const r = computeBurndown({ concepts: live, edges, events, now, scope: "s1" });
    expect(r.scope).toMatchObject({ id: "s1", kind: "concept", type: "iteration" });
    expect(r.window.from).toBe("2026-11-02T00:00:00.000Z");
    expect(r.window.to).toBe("2026-11-14T00:00:00.000Z");
    expect(r.window.bucket).toBe("day");
    expect(r.totals).toEqual({ scope: 3, done: 2, open: 1, taken: 1, unestimated: 0 });
    const s = r.series ?? [];
    expect(s[0]).toMatchObject({ at: "2026-11-02T00:00:00.000Z", scope: 0, ideal: 0 });
    const nov5 = s.find((p) => p.at === "2026-11-05T00:00:00.000Z");
    expect(nov5).toMatchObject({ scope: 3, done: 1, open: 2 });
    expect(s.find((p) => p.at === now)).toMatchObject({ open: 1, done: 2 });
    expect(s.at(-1)).toMatchObject({ scope: null, ideal: 0 });
    // Ideal: remaining at start (0 — tasks arrive at 09:00) — use a window after creation instead.
    const r2 = computeBurndown({
      concepts: live.map((c) => (c.id === "s1" ? { ...c, startDate: "2026-11-03" } : c)),
      edges,
      events,
      now,
      scope: "s1",
    });
    const first = r2.series?.[0];
    expect(first?.ideal).toBe(3);
    const mid = r2.series?.find((p) => p.at === "2026-11-08T12:00:00.000Z");
    expect(mid?.ideal).toBeCloseTo(3 * (1 - 5.5 / 11), 2);
  });

  it("rolls iterations and later additions up into the milestone", () => {
    const r = computeBurndown({ concepts: live, edges, events, now, scope: "m1" });
    expect(r.totals.scope).toBe(4);
    expect(r.scopeChanges?.map((c) => [c.task, c.change])).toEqual([
      ["t1", "added"],
      ["t2", "added"],
      ["t3", "added"],
      ["t4", "added"],
    ]);
    expect(r.velocity?.by).toBe("iteration");
    expect(r.velocity?.periods).toEqual([
      expect.objectContaining({ id: "s1", label: "Sprint 1", done: 2, complete: false }),
    ]);
  });

  it("counts points and reports unestimated tasks", () => {
    const r = computeBurndown({ concepts: live, edges, events, now, scope: "m1", unit: "points" });
    expect(r.totals).toEqual({ scope: 10, done: 7, open: 3, taken: 3, unestimated: 1 });
  });

  it("scopes by tag and by the whole vault", () => {
    expect(computeBurndown({ concepts: live, edges, events, now, scope: "tag:p1" }).totals.scope).toBe(1);
    expect(computeBurndown({ concepts: live, edges, events, now }).totals.scope).toBe(4);
  });

  it("records removals as scope changes", () => {
    const moved: TaskEvent[] = [
      ...events,
      { at: D("2026-11-08", 9), task: "t2", kind: "scope_removed", scope: "s1" },
      { at: D("2026-11-08", 9), task: "t2", kind: "scope_added", scope: "s2" },
    ];
    const liveMoved = live.map((c) => c);
    const edgesMoved = edges.map((e) =>
      e.from === "t2" ? { from: "t2", to: "s2", relation: "part_of" } : e,
    );
    const r = computeBurndown({
      concepts: liveMoved,
      edges: edgesMoved,
      events: moved,
      now,
      scope: "s1",
    });
    expect(r.totals.scope).toBe(2);
    expect(r.scopeChanges?.at(-1)).toMatchObject({ task: "t2", change: "removed" });
  });

  it("measures lead/cycle per agent and flags stale claims", () => {
    const r = computeBurndown({ concepts: live, edges, events, now, scope: "m1", staleAfterHours: 48 });
    expect(r.cycle?.leadHours.count).toBe(2);
    // t1: created 11-02 09:00 → done 11-04 10:00 = 49h; t3: 11-02 09:00 → 11-07 09:00 = 120h
    expect(r.cycle?.byAgent).toEqual([
      expect.objectContaining({
        agent: "agent-a",
        leadHours: expect.objectContaining({ count: 2, median: 84.5 }),
        cycleHours: expect.objectContaining({ median: 24 }),
      }),
    ]);
    // t2 taken 11-04 11:00, now 11-08 12:00 → 97h
    expect(r.stale).toEqual([
      { id: "t2", title: "T2", takenBy: "agent-b", takenAt: D("2026-11-04", 11), ageHours: 97 },
    ]);
    expect(r.agents).toEqual([
      { agent: "agent-a", held: 0, done: 2, medianLeadHours: 84.5, medianCycleHours: 24, stale: 0 },
      { agent: "agent-b", held: 1, done: 0, medianLeadHours: null, medianCycleHours: null, stale: 1 },
    ]);
  });

  it("projects completion from weekly throughput", () => {
    const r = computeBurndown({ concepts: live, edges, events, now, scope: "m1" });
    // Scope is < 1 week old: one sample of 2 done; 2 remaining → 1 week.
    expect(r.projection).toMatchObject({ remaining: 2, samples: 1, ratePerWeek: { mean: 2, stdev: 0 } });
    expect(r.projection?.likely).toBe(new Date(Date.parse(now) + 7 * 86_400_000).toISOString());
    expect(r.projection?.onTrack).toBe(true);
  });

  it("explains a missing projection", () => {
    const r = computeBurndown({
      concepts: [task("x", { createdAt: D("2026-10-01") })],
      edges: [],
      events: [],
      now,
    });
    expect(r.projection?.likely).toBeNull();
    expect(r.projection?.reason).toMatch(/no work finished/);
    expect(r.velocity?.by).toBe("week");
    expect(r.velocity?.periods[0].label).toBe("2026-09-07");
  });

  it("selects metrics and rejects unknown scopes / windows", () => {
    const r = computeBurndown({ concepts: live, edges, events, now, metrics: ["stale"] });
    expect(r.series).toBeUndefined();
    expect(r.stale).toBeDefined();
    expect(() => computeBurndown({ concepts: live, edges, events, now, scope: "nope" })).toThrow(
      UnknownScopeError,
    );
    expect(() =>
      computeBurndown({ concepts: live, edges, events, now, from: "2026-11-05", to: "2026-11-01" }),
    ).toThrow(/before/);
  });

  it("closes over nested containers without looping", () => {
    const loop: Edge[] = [
      { from: "a", to: "b", relation: "part_of" },
      { from: "b", to: "a", relation: "realizes" },
    ];
    expect([...scopeClosure("a", loop)].sort()).toEqual(["a", "b"]);
  });
});
