import { describe, expect, it } from "vitest";
import {
  UnknownScopeError,
  backfillTaskEvents,
  computeBurndown,
  diffTaskEvents,
  missingTaskHistory,
  nearestContainer,
  scopeClosure,
  taskHistoryRepair,
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

  it("keeps a claim made before the log started when the task finishes after", () => {
    const c = [
      task("a", {
        createdAt: D("2026-10-01"),
        taskStatus: "done",
        takenBy: "w1",
        takenAt: D("2026-10-02"),
        doneAt: D("2026-10-03"),
      }),
    ];
    // Only the live `done` was recorded (the claim predates history).
    const ev = backfillTaskEvents(c, [], [{ at: D("2026-10-03"), task: "a", kind: "done", by: "w1" }]);
    expect(ev.map((e) => [e.kind, e.at])).toEqual([
      ["created", D("2026-10-01")],
      ["taken", D("2026-10-02")],
      ["done", D("2026-10-03")],
    ]);
    expect(backfillTaskEvents(c, [], ev)).toEqual(ev);
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
    // The sprint was empty at 00:00; its tasks arrived at 09:00, so the ideal
    // anchors there (3 remaining) and runs to 0 at the end of Nov 13.
    expect(s[0]).toMatchObject({ at: "2026-11-02T00:00:00.000Z", scope: 0, ideal: null });
    expect(s.find((p) => p.at === D("2026-11-02", 9))).toMatchObject({ scope: 3, ideal: 3 });
    const nov5 = s.find((p) => p.at === "2026-11-05T00:00:00.000Z");
    expect(nov5).toMatchObject({ scope: 3, done: 1, open: 2 });
    expect(s.find((p) => p.at === now)).toMatchObject({ open: 1, done: 2 });
    expect(s.at(-1)).toMatchObject({ scope: null, ideal: 0 });
    // A sprint that already had its work at its start anchors there.
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

  it("finds the nearest container outward: fewest hops, part_of first, cycle-safe", () => {
    const edges: Edge[] = [
      { from: "t", to: "f", relation: "realizes" },
      { from: "t", to: "e1", relation: "part_of" },
      { from: "f", to: "e2", relation: "part_of" },
      { from: "x", to: "y", relation: "part_of" },
      { from: "y", to: "x", relation: "realizes" },
    ];
    const epics = new Set(["e1", "e2"]);
    expect(nearestContainer("t", edges, (id) => epics.has(id))).toBe("e1");
    // Without the direct edge, the epic inherited through the feature remains.
    const inherited = edges.filter((e) => e.to !== "e1");
    expect(nearestContainer("t", inherited, (id) => epics.has(id))).toBe("e2");
    expect(nearestContainer("x", edges, (id) => epics.has(id))).toBeUndefined();
  });
});

describe("review regressions", () => {
  const at = D("2026-11-02", 9);

  it("keeps recorded order for equal timestamps (remove then re-add a scope)", () => {
    // Two writes inside one millisecond: s1 removed, then re-added.
    const log: TaskEvent[] = [
      { at: D("2026-11-01"), task: "t", kind: "created" },
      { at: D("2026-11-01"), task: "t", kind: "scope_added", scope: "s1" },
      { at, task: "t", kind: "scope_removed", scope: "s1" },
      { at, task: "t", kind: "scope_added", scope: "s1" },
    ];
    const concepts = [task("t", { createdAt: D("2026-11-01") })];
    const edges: Edge[] = [{ from: "t", to: "s1", relation: "part_of" }];
    const once = backfillTaskEvents(concepts, edges, log);
    expect(once.map((e) => e.kind)).toEqual(["created", "scope_added", "scope_removed", "scope_added"]);
    // Idempotent: nothing reconciled, nothing reordered, the log never grows.
    expect(backfillTaskEvents(concepts, edges, once)).toEqual(once);
    const s1 = { id: "s1", title: "S1", type: "iteration", tags: [] };
    const r = computeBurndown({ concepts: [...concepts, s1], edges, events: log, now: D("2026-11-03"), scope: "s1" });
    expect(r.totals.scope).toBe(1);
  });

  it("records a reclaim under the same label and clears the stale claim", () => {
    const prev = { id: "t", taskStatus: "taken" as const, takenBy: "an agent", takenAt: D("2026-11-01"), scopes: [] };
    const next = { ...prev, takenAt: D("2026-11-03") };
    expect(diffTaskEvents(prev, next, D("2026-11-03")).map((e) => [e.kind, e.by])).toEqual([["taken", "an agent"]]);
    // Same claim, unrelated write: no event.
    expect(diffTaskEvents(prev, { ...prev }, D("2026-11-03"))).toEqual([]);

    // Backfill also notices a claim newer than the replayed one.
    const concepts = [
      task("t", { createdAt: D("2026-11-01", 0), taskStatus: "taken", takenBy: "an agent", takenAt: D("2026-11-03", 11) }),
    ];
    const log: TaskEvent[] = [
      { at: D("2026-11-01", 0), task: "t", kind: "created" },
      { at: D("2026-11-01", 12), task: "t", kind: "taken", by: "an agent" },
    ];
    const r = computeBurndown({ concepts, edges: [], events: log, now: D("2026-11-03", 12), staleAfterHours: 24 });
    expect(r.stale).toEqual([]);
    expect(r.agents?.[0]).toMatchObject({ agent: "an agent", held: 1, stale: 0 });
    const ev = backfillTaskEvents(concepts, [], log);
    expect(backfillTaskEvents(concepts, [], ev)).toEqual(ev);
  });

  it("counts each iteration's velocity from its own tasks only", () => {
    const concepts: BurndownConcept[] = [
      { id: "m", title: "M", type: "milestone", tags: [] },
      { id: "i1", title: "I1", type: "iteration", tags: [], startDate: "2026-11-02", endDate: "2026-11-13" },
      { id: "i2", title: "I2", type: "iteration", tags: [], startDate: "2026-11-02", endDate: "2026-11-13" },
      task("t", { createdAt: D("2026-11-02"), taskStatus: "done", doneAt: D("2026-11-04") }),
    ];
    const edges: Edge[] = [
      { from: "i1", to: "m", relation: "part_of" },
      { from: "i2", to: "m", relation: "part_of" },
      { from: "t", to: "i1", relation: "part_of" },
    ];
    const r = computeBurndown({ concepts, edges, events: [], now: D("2026-11-06"), scope: "m" });
    expect(r.velocity?.periods.map((p) => [p.id, p.done])).toEqual([
      ["i1", 1],
      ["i2", 0],
    ]);
  });

  it("missingTaskHistory returns what a deletion must persist", () => {
    const c = task("t", {
      createdAt: D("2026-10-01"),
      taskStatus: "done",
      takenBy: "w",
      takenAt: D("2026-10-02"),
      doneAt: D("2026-10-03"),
    });
    const edges: Edge[] = [{ from: "t", to: "dom", relation: "part_of" }];
    const missing = missingTaskHistory(c, edges, []);
    expect(missing.map((e) => e.kind)).toEqual(["created", "scope_added", "taken", "done"]);
    // Persisted + deleted, the task still counts for October.
    const after = [...missing, { at: D("2026-11-10"), task: "t", kind: "deleted" as const }];
    const dom = { id: "dom", title: "Dom", type: "domain", tags: [] };
    const r = computeBurndown({ concepts: [dom], edges: [], events: after, now: D("2026-11-12"), scope: "dom", from: "2026-10-01" });
    expect(r.series?.find((p) => p.at === D("2026-10-05", 0))).toMatchObject({ scope: 1, done: 1 });
    expect(r.totals.scope).toBe(0);
    // Nothing missing once the log has it all.
    expect(missingTaskHistory(c, edges, missing)).toEqual([]);
  });
});

describe("a re-created task id starts a fresh lifecycle", () => {
  // Done Nov 3, deleted Nov 4, re-created open Nov 8, done again Nov 10.
  const edges: Edge[] = [{ from: "t", to: "m", relation: "part_of" }];
  const events: TaskEvent[] = [
    { at: D("2026-11-01"), task: "t", kind: "created" },
    { at: D("2026-11-01"), task: "t", kind: "scope_added", scope: "m" },
    { at: D("2026-11-01"), task: "t", kind: "estimated", points: 5 },
    { at: D("2026-11-03"), task: "t", kind: "done", by: "a" },
    { at: D("2026-11-04"), task: "t", kind: "deleted" },
    { at: D("2026-11-08"), task: "t", kind: "created" },
    { at: D("2026-11-08"), task: "t", kind: "scope_added", scope: "m" },
    { at: D("2026-11-10"), task: "t", kind: "done", by: "b" },
  ];
  const concepts = [
    { id: "m", title: "M", type: "milestone", tags: [] },
    task("t", { taskStatus: "done", takenBy: "b", createdAt: D("2026-11-08"), doneAt: D("2026-11-10") }),
  ];
  const r = computeBurndown({
    concepts,
    edges,
    events,
    now: D("2026-11-12"),
    scope: "m",
    from: "2026-11-01",
    to: "2026-11-12",
  });
  const at = (day: string) => r.series?.find((p) => p.at === `${day}T00:00:00.000Z`);

  it("is open (not done) between re-creation and its second completion", () => {
    expect(at("2026-11-09")).toMatchObject({ scope: 1, done: 0, open: 1 });
    expect(at("2026-11-11")).toMatchObject({ scope: 1, done: 1, open: 0 });
  });

  it("counts the second completion as velocity", () => {
    // Weeks start Monday: Oct 26 (window start), Nov 2 (first completion), Nov 9 (the second).
    expect(r.velocity?.periods.map((p) => [p.from.slice(0, 10), p.done])).toEqual([
      ["2026-10-26", 0],
      ["2026-11-02", 1],
      ["2026-11-09", 1],
    ]);
  });

  it("times the new life from its own creation and drops the old estimate", () => {
    // 48h for the first life (Nov 1 → Nov 3), 48h for the second (Nov 8 → Nov 10).
    expect(r.cycle?.leadHours).toMatchObject({ count: 2, median: 48 });
    const points = computeBurndown({ concepts, edges, events, now: D("2026-11-12"), scope: "m", unit: "points" });
    expect(points.totals).toMatchObject({ scope: 0, unestimated: 1 });
  });

  it("backfill keeps the current note's memberships after the latest creation", () => {
    // A hand-added membership the log never mentioned is present since the re-creation.
    const merged = backfillTaskEvents(
      concepts,
      [...edges, { from: "t", to: "s", relation: "part_of" }],
      events,
    );
    const added = merged.filter((e) => e.kind === "scope_added" && e.scope === "s");
    expect(added).toEqual([{ at: D("2026-11-08"), task: "t", kind: "scope_added", scope: "s" }]);
    const createdIdx = merged.map((e) => e.kind).lastIndexOf("created");
    expect(merged.indexOf(added[0])).toBeGreaterThan(createdIdx);
  });
});

describe("projection onTrack", () => {
  const edges: Edge[] = [{ from: "t", to: "m", relation: "part_of" }];
  const run = (doneDay: string) =>
    computeBurndown({
      concepts: [
        { id: "m", title: "M", type: "milestone", tags: [], endDate: "2026-11-05" },
        task("t", { taskStatus: "done", createdAt: D("2026-11-01"), doneAt: D(doneDay) }),
      ],
      edges,
      events: [],
      now: D("2026-11-12"),
      scope: "m",
    }).projection;

  it("is false when the scope finished after its end date", () => {
    expect(run("2026-11-10")).toMatchObject({ remaining: 0, likely: D("2026-11-10"), onTrack: false });
  });
  it("is true when it finished by its end date", () => {
    expect(run("2026-11-05")).toMatchObject({ remaining: 0, onTrack: true });
  });
  it("ignores completions made after the task left the scope", () => {
    // Done in Sprint A on Nov 3, moved out on Nov 4, reopened and done elsewhere on Nov 10.
    const p = computeBurndown({
      concepts: [
        { id: "a", title: "A", type: "iteration", tags: [], startDate: "2026-11-01", endDate: "2026-11-05" },
        { id: "b", title: "B", type: "iteration", tags: [] },
        task("t", { taskStatus: "done", createdAt: D("2026-11-01"), doneAt: D("2026-11-10") }),
      ],
      edges: [{ from: "t", to: "b", relation: "part_of" }],
      events: [
        { at: D("2026-11-01"), task: "t", kind: "created" },
        { at: D("2026-11-01"), task: "t", kind: "scope_added", scope: "a" },
        { at: D("2026-11-03"), task: "t", kind: "done" },
        { at: D("2026-11-04"), task: "t", kind: "scope_added", scope: "b" },
        { at: D("2026-11-04"), task: "t", kind: "scope_removed", scope: "a" },
        { at: D("2026-11-08"), task: "t", kind: "reopened" },
        { at: D("2026-11-10"), task: "t", kind: "done" },
      ],
      now: D("2026-11-12"),
      scope: "a",
    }).projection;
    expect(p).toMatchObject({ remaining: 0, likely: D("2026-11-03"), onTrack: true });
  });
});

describe("persisted backfill keeps its causal order", () => {
  // Created already done on Nov 1 (claim from Oct 30, before the log), estimate changed Nov 9.
  const created: TaskEvent = { at: D("2026-11-01"), task: "t", kind: "created" };
  const done: TaskEvent = { at: D("2026-11-01"), task: "t", kind: "done", by: "w" };
  const before = task("t", {
    createdAt: D("2026-11-01"),
    updatedAt: D("2026-11-01"),
    taskStatus: "done",
    takenBy: "w",
    takenAt: D("2026-10-30"),
    doneAt: D("2026-11-01"),
  });
  const after = { ...before, estimate: 3, updatedAt: D("2026-11-09") };
  const estimated: TaskEvent = { at: D("2026-11-09"), task: "t", kind: "estimated", points: 3 };
  const completions = (events: TaskEvent[]) => {
    const r = computeBurndown({ concepts: [after], edges: [], events, now: D("2026-11-12"), from: "2026-10-25", bucket: "day" });
    return { done: r.totals.done, velocity: r.velocity?.periods.reduce((n, p) => n + p.done, 0) };
  };

  it("replaces the log when a synthesized claim must replay before a logged done", () => {
    const repair = taskHistoryRepair(before, [], [created, done]);
    expect(repair.kind).toBe("replace");
    const persisted = repair.kind === "none" ? [] : repair.events;
    expect(persisted.map((e) => e.kind)).toEqual(["taken", "created", "done"]);
    expect(persisted[0]).toMatchObject({ at: D("2026-11-01"), by: "w" });
    // No invented second completion on Nov 9.
    expect(completions([...persisted, estimated])).toEqual({ done: 1, velocity: 1 });
    // Appending (the old behaviour) replays taken after done and invents one.
    expect(completions([created, done, ...persisted.slice(0, 1), estimated]).velocity).toBe(2);
    // Idempotent: nothing more to persist once the log holds it.
    expect(taskHistoryRepair(before, [], persisted)).toEqual({ kind: "none" });
    expect(taskHistoryRepair(after, [], [...persisted, estimated])).toEqual({ kind: "none" });
  });

  it("appends when the synthesized history already sorts before the log", () => {
    const legacy = task("t", { createdAt: D("2026-10-01"), taskStatus: "done", takenBy: "w", takenAt: D("2026-10-02"), doneAt: D("2026-10-03") });
    const repair = taskHistoryRepair(legacy, [], []);
    expect(repair.kind).toBe("append");
    expect(repair.kind === "none" ? [] : repair.events.map((e) => e.kind)).toEqual(["created", "taken", "done"]);
    expect(taskHistoryRepair(legacy, [], [{ at: D("2026-11-05"), task: "t", kind: "reopened" }]).kind).toBe("append");
  });
});
