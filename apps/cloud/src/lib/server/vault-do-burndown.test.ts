/**
 * Burndown through the REAL VaultDO class over better-sqlite3 (same shim as
 * vault-do-dream.test.ts): every write path records task events, burndown
 * reads them (plus backfill), the result parses against the contract, and the
 * v8 → v9 migration adds the columns, the history table and the two types.
 */
import Database from "better-sqlite3";
import { burndownResultSchema, BUILTIN_CONCEPT_TYPES } from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { VaultDO } from "./vault-do";

function fakeState() {
  const db = new Database(":memory:");
  let ready: Promise<unknown> = Promise.resolve();
  const sql = {
    exec(query: string, ...binds: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.reader ? (stmt.all(...binds) as Record<string, unknown>[]) : (stmt.run(...binds), []);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
  const state = {
    storage: {
      sql,
      getAlarm: async () => null,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      deleteAll: async () => {},
    },
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  return { state, ready: () => ready, db };
}

async function freshVault() {
  const fake = fakeState();
  const vault = new VaultDO(fake.state as never, {});
  await fake.ready();
  return { vault, fake };
}

describe("VaultDO burndown", () => {
  it("records every task transition and computes the scope's burndown", async () => {
    const { vault } = await freshVault();
    await vault.upsertConcept({ id: "m1", title: "M1", body: "", type: "milestone", endDate: "2099-01-31" });
    await vault.upsertConcept({
      id: "s1",
      title: "Sprint 1",
      body: "",
      type: "iteration",
      startDate: "2026-11-02",
      endDate: "2026-11-13",
      relations: { part_of: ["m1"] },
    });
    expect((await vault.getConcept("s1")).concept).toMatchObject({
      type: "iteration",
      startDate: "2026-11-02",
      endDate: "2026-11-13",
    });
    await vault.upsertConcept({ id: "t1", title: "T1", body: "", type: "task", taskStatus: "open", estimate: 2 });
    await vault.link({ from: "t1", to: "s1", relation: "part_of" });
    await vault.takeTask({ id: "t1", takenBy: "agent-a" });
    vault.reopenTask({ id: "t1" });
    await vault.takeTask({ id: "t1", takenBy: "agent-b" });
    await vault.completeTask({ id: "t1", outcome: "done" });
    await vault.upsertConcept({
      id: "t2",
      title: "T2",
      body: "",
      type: "task",
      taskStatus: "open",
      relations: { part_of: ["s1"] },
    });
    // Moving t2 out of the sprint is a scope change.
    await vault.upsertConcept({ id: "t2", title: "T2", body: "", relations: { part_of: ["m1"] } });
    vault.deleteConcept("t2");

    const kinds = vault.taskEvents().map((e) => `${e.task}:${e.kind}${e.scope ? `:${e.scope}` : ""}`);
    expect(kinds).toEqual([
      "t1:created",
      "t1:estimated",
      "t1:scope_added:s1",
      "t1:taken",
      "t1:released",
      "t1:taken",
      "t1:done",
      "t2:created",
      "t2:scope_added:s1",
      "t2:scope_added:m1",
      "t2:scope_removed:s1",
      "t2:deleted",
    ]);

    const r = vault.burndown({ scope: "m1" });
    expect(burndownResultSchema.safeParse(r).success).toBe(true);
    expect(r.totals).toMatchObject({ scope: 1, done: 1, open: 0 });
    expect(r.velocity?.by).toBe("iteration");
    expect(r.agents?.map((a) => a.agent)).toEqual(["agent-b"]);
    expect(r.scopeChanges?.filter((c) => c.task === "t2").map((c) => c.change)).toEqual(["added", "removed"]);
    expect(vault.burndown({ scope: "m1", unit: "points" }).totals.done).toBe(2);
  });

  it("serves burndown over fetch: 404 for an unknown scope, 400 for a bad window", async () => {
    const { vault } = await freshVault();
    const call = (args: unknown) =>
      vault.fetch(new Request("https://vault-do/burndown", { method: "POST", body: JSON.stringify(args) }));
    expect((await call({})).status).toBe(200);
    expect((await call({ scope: "nope" })).status).toBe(404);
    expect((await call({ from: "2026-11-05", to: "2026-11-01" })).status).toBe(400);
  });

  it("backfills a task that predates the history table", async () => {
    const { vault, fake } = await freshVault();
    await vault.upsertConcept({ id: "t", title: "T", body: "", type: "task", taskStatus: "open" });
    await vault.takeTask({ id: "t", takenBy: "w" });
    fake.db.exec(`DELETE FROM task_event`);
    const r = vault.burndown({ staleAfterHours: 1 }, new Date(Date.now() + 2 * 3_600_000));
    expect(r.totals).toMatchObject({ scope: 1, taken: 1 });
    expect(r.stale?.map((s) => s.takenBy)).toEqual(["w"]);
  });
});

describe("VaultDO schema v9 migration", () => {
  it("adds burndown columns, the history table and the new built-in types to a v8 vault", async () => {
    const fake = fakeState();
    new VaultDO(fake.state as never, {});
    await fake.ready();
    // Rewind to v8: drop what v9 added.
    fake.db.exec(`DROP TABLE task_event`);
    for (const col of ["start_date", "end_date", "estimate"]) fake.db.exec(`ALTER TABLE concept DROP COLUMN ${col}`);
    fake.db.exec(`DELETE FROM concept_type WHERE key IN ('iteration', 'milestone')`);
    // A custom type that already took one of the keys keeps its own colour.
    fake.db
      .prepare(`INSERT INTO concept_type (key, label, color, weight, sort_order, hidden, builtin) VALUES ('milestone', 'Goal', '#123456', 50, 3, 0, 0)`)
      .run();
    fake.db.prepare(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`).run();

    const vault = new VaultDO(fake.state as never, {});
    await fake.ready();
    const cols = (fake.db.prepare(`PRAGMA table_info(concept)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["start_date", "end_date", "estimate"]));
    expect(fake.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({ value: "9" });
    const types = vault.listTypes().types;
    const iteration = types.find((t) => t.key === "iteration");
    const builtinIteration = BUILTIN_CONCEPT_TYPES.find((t) => t.key === "iteration");
    expect(iteration).toMatchObject({ builtin: true, color: builtinIteration?.color });
    // Appended after the existing rows (the 11 older built-ins are 0..10).
    expect(iteration!.order).toBe(11);
    expect(types.find((t) => t.key === "milestone")).toMatchObject({ label: "Goal", color: "#123456", builtin: false });
    await vault.upsertConcept({ id: "t", title: "T", body: "", type: "task", estimate: 1 });
    expect(vault.taskEvents().map((e) => e.kind)).toEqual(["created", "estimated"]);
  });
});

describe("VaultDO schema v9 migration on a v8 vault that already has tasks", () => {
  /** Rewind a fresh DO to the exact v8 shape: no task_event, no burndown columns, 11 types. */
  function rewindToV8(fake: ReturnType<typeof fakeState>) {
    fake.db.exec(`DROP TABLE task_event`);
    for (const col of ["start_date", "end_date", "estimate"]) fake.db.exec(`ALTER TABLE concept DROP COLUMN ${col}`);
    fake.db.exec(`DELETE FROM concept_type WHERE key IN ('iteration', 'milestone')`);
    fake.db.prepare(`UPDATE meta SET value = '8' WHERE key = 'schema_version'`).run();
  }

  /** Insert a concept row the way a v8 DO stored it (v8 columns only) plus its typed edges. */
  function putV8Row(
    fake: ReturnType<typeof fakeState>,
    row: {
      id: string;
      type: string;
      task_status?: string | null;
      taken_by?: string | null;
      taken_at?: string | null;
      done_at?: string | null;
      relations?: Record<string, string[]>;
      created_at: string;
    },
  ) {
    fake.db
      .prepare(
        `INSERT INTO concept (id, title, type, status, product, tags_json, code_areas_json, task_status, taken_by, taken_at, done_at, relations_json, body, hash, created_at, updated_at)
         VALUES (?, ?, ?, 'active', NULL, '[]', '[]', ?, ?, ?, ?, ?, 'body\n', 'h', ?, ?)`,
      )
      .run(
        row.id,
        row.id.toUpperCase(),
        row.type,
        row.task_status ?? null,
        row.taken_by ?? null,
        row.taken_at ?? null,
        row.done_at ?? null,
        JSON.stringify(row.relations ?? {}),
        row.created_at,
        row.done_at ?? row.taken_at ?? row.created_at,
      );
    for (const [relation, targets] of Object.entries(row.relations ?? {})) {
      for (const to of targets) {
        fake.db
          .prepare(`INSERT INTO edge (from_id, to_id, relation, src) VALUES (?, ?, ?, 'frontmatter')`)
          .run(row.id, to, relation);
      }
    }
  }

  it("is additive: v8 rows, edges and registry survive; history backfills; new writes append", async () => {
    const fake = fakeState();
    new VaultDO(fake.state as never, {});
    await fake.ready();
    rewindToV8(fake);
    putV8Row(fake, { id: "auth", type: "domain", created_at: "2026-10-01T00:00:00.000Z" });
    putV8Row(fake, {
      id: "t-done",
      type: "task",
      task_status: "done",
      taken_by: "agent-a",
      taken_at: "2026-10-02T00:00:00.000Z",
      done_at: "2026-10-03T00:00:00.000Z",
      relations: { part_of: ["auth"] },
      created_at: "2026-10-01T00:00:00.000Z",
    });
    putV8Row(fake, {
      id: "t-taken",
      type: "task",
      task_status: "taken",
      taken_by: "agent-b",
      taken_at: "2026-10-04T00:00:00.000Z",
      relations: { part_of: ["auth"] },
      created_at: "2026-10-01T12:00:00.000Z",
    });
    putV8Row(fake, {
      id: "t-open",
      type: "task",
      relations: { part_of: ["auth"] },
      created_at: "2026-10-05T00:00:00.000Z",
    });
    const before = fake.db.prepare(`SELECT * FROM concept ORDER BY id`).all() as Record<string, unknown>[];
    const edgesBefore = fake.db.prepare(`SELECT * FROM edge ORDER BY from_id, to_id`).all();
    const typesBefore = fake.db.prepare(`SELECT * FROM concept_type ORDER BY key`).all();

    // Reopen: the constructor runs the v8 → v9 migration.
    const vault = new VaultDO(fake.state as never, {});
    await fake.ready();
    expect(fake.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({ value: "9" });

    // Additive: every v8 column value is unchanged, the new columns are null,
    // edges are untouched, and the old registry rows are kept as they were.
    const after = fake.db.prepare(`SELECT * FROM concept ORDER BY id`).all() as Record<string, unknown>[];
    expect(after).toHaveLength(before.length);
    after.forEach((row, i) => {
      const { start_date, end_date, estimate, ...rest } = row;
      expect(rest).toEqual(before[i]);
      expect([start_date, end_date, estimate]).toEqual([null, null, null]);
    });
    expect(fake.db.prepare(`SELECT * FROM edge ORDER BY from_id, to_id`).all()).toEqual(edgesBefore);
    const typesAfter = fake.db.prepare(`SELECT * FROM concept_type ORDER BY key`).all() as { key: string }[];
    expect(typesAfter.filter((t) => t.key !== "iteration" && t.key !== "milestone")).toEqual(typesBefore);
    expect(typesAfter.map((t) => t.key)).toEqual(expect.arrayContaining(["iteration", "milestone"]));
    // The history table starts empty: nothing is written for old tasks…
    expect(vault.taskEvents()).toEqual([]);

    // …but reads backfill it from created_at / taken_at / done_at.
    const now = new Date("2026-10-10T00:00:00.000Z");
    const r = vault.burndown({ scope: "auth", from: "2026-10-01" }, now);
    expect(burndownResultSchema.safeParse(r).success).toBe(true);
    expect(r.totals).toEqual({ scope: 3, done: 1, open: 2, taken: 1, unestimated: 3 });
    expect(r.cycle?.leadHours.median).toBe(48); // t-done: 10-01 → 10-03
    expect(r.cycle?.cycleHours.median).toBe(24); // taken 10-02 → done 10-03
    expect(r.stale?.map((s) => [s.id, s.takenBy, s.ageHours])).toEqual([["t-taken", "agent-b", 144]]);
    expect(r.agents?.map((a) => [a.agent, a.held, a.done])).toEqual([
      ["agent-a", 0, 1],
      ["agent-b", 1, 0],
    ]);
    const oct4 = r.series?.find((p) => p.at === "2026-10-04T00:00:00.000Z");
    expect(oct4).toMatchObject({ scope: 2, done: 1, open: 1 }); // t-open arrives 10-05

    // A write after the upgrade appends live events on top of the backfill
    // without duplicating it: one done, no second created/taken.
    await vault.completeTask({ id: "t-taken", outcome: "finished after the upgrade" });
    expect(vault.taskEvents().map((e) => `${e.task}:${e.kind}`)).toEqual(["t-taken:done"]);
    const r2 = vault.burndown({ scope: "auth", from: "2026-10-01" });
    expect(r2.totals).toMatchObject({ scope: 3, done: 2, open: 1, taken: 0 });
    expect(r2.agents?.find((a) => a.agent === "agent-b")).toMatchObject({ held: 0, done: 1 });
    // The pre-upgrade claim still starts its cycle time (backfilled `taken` at taken_at).
    const b = r2.cycle?.byAgent.find((a) => a.agent === "agent-b");
    expect(b?.cycleHours.count).toBe(1);
  });
});

describe("review regressions (VaultDO)", () => {
  it("setMembership swaps the iteration from stored relations, keeping links a stale client never saw", async () => {
    const { vault } = await freshVault();
    for (const [id, type] of [
      ["auth", "domain"],
      ["s1", "iteration"],
      ["s2", "iteration"],
      ["m1", "milestone"],
      ["dep", "feature"],
    ] as const) {
      await vault.upsertConcept({ id, title: id, body: "", type });
    }
    await vault.upsertConcept({
      id: "t",
      title: "T",
      body: "See [[dep]].",
      type: "task",
      taskStatus: "open",
      relations: { part_of: ["auth", "s1"] },
    });
    // An agent adds links after the board's graph cache was taken.
    await vault.link({ from: "t", to: "dep", relation: "depends_on" });
    await vault.link({ from: "t", to: "m1", relation: "part_of" });

    const { concept } = await vault.setMembership({ id: "t", type: "iteration", target: "s2" });
    expect(concept.id).toBe("t");
    const edges = await storedEdges(vault, "t");
    expect(edges).toEqual(
      expect.arrayContaining(["part_of:auth", "part_of:m1", "part_of:s2", "depends_on:dep", "references:dep"]),
    );
    expect(edges).not.toContain("part_of:s1");
    expect(vault.taskEvents().filter((e) => e.task === "t").slice(-2).map((e) => `${e.kind}:${e.scope}`)).toEqual([
      "scope_added:s2",
      "scope_removed:s1",
    ]);

    // null clears just the iteration; a wrong type or unknown target is refused.
    await vault.setMembership({ id: "t", type: "iteration", target: null });
    expect((await storedEdges(vault, "t")).filter((e) => e.startsWith("part_of:"))).toEqual(["part_of:auth", "part_of:m1"]);
    expect(() => vault.setMembership({ id: "t", type: "iteration", target: "auth" })).toThrow(/not a iteration/);
    const res = await vault.fetch(
      new Request("https://vault-do/setMembership", {
        method: "POST",
        body: JSON.stringify({ id: "t", type: "iteration", target: "ghost" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("setMembership is atomic: a link added while the assignment is in flight survives", async () => {
    // Re-review P1: the swap used to go through upsertConcept, which awaits
    // hashing between reading the stored relations and writing them, so an
    // agent's link landing in that window was overwritten.
    const { vault } = await freshVault();
    for (const [id, type] of [
      ["auth", "domain"],
      ["s1", "iteration"],
      ["s2", "iteration"],
    ] as const) {
      await vault.upsertConcept({ id, title: id, body: "", type });
    }
    await vault.upsertConcept({ id: "t", title: "T", body: "", type: "task", relations: { part_of: ["s1"] } });

    // Start the assignment, add a domain link before awaiting it, then await.
    // (Called first and not awaited: the old code yielded inside the swap,
    // so the link ran between its read and its write.)
    const assignment = Promise.resolve(vault.setMembership({ id: "t", type: "iteration", target: "s2" }));
    const linking = vault.link({ from: "t", to: "auth", relation: "part_of" });
    await Promise.all([assignment, linking]);
    expect((await storedEdges(vault, "t")).filter((e) => e.startsWith("part_of:"))).toEqual([
      "part_of:auth",
      "part_of:s2",
    ]);

    // And the other interleaving: the link first, the assignment in flight.
    const linkFirst = vault.link({ from: "t", to: "s1", relation: "related_to" });
    const reassign = Promise.resolve(vault.setMembership({ id: "t", type: "iteration", target: "s1" }));
    await Promise.all([linkFirst, reassign]);
    expect(await storedEdges(vault, "t")).toEqual(
      expect.arrayContaining(["part_of:auth", "part_of:s1", "related_to:s1"]),
    );
    expect(await storedEdges(vault, "t")).not.toContain("part_of:s2");
  });

  it("deleting a task from before the history table keeps its rebuilt history", async () => {
    const { vault, fake } = await freshVault();
    await vault.upsertConcept({ id: "auth", title: "Auth", body: "", type: "domain" });
    await vault.upsertConcept({ id: "t", title: "T", body: "", type: "task", relations: { part_of: ["auth"] } });
    // Make it look pre-upgrade: an October task done in October, with no recorded history.
    fake.db
      .prepare(
        `UPDATE concept SET task_status = 'done', taken_by = 'w', taken_at = ?, done_at = ?, created_at = ? WHERE id = 't'`,
      )
      .run("2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    fake.db.exec(`DELETE FROM task_event`);
    const now = new Date("2026-11-10T00:00:00.000Z");
    const before = vault.burndown({ scope: "auth", from: "2026-10-01" }, now);
    const oct5 = (r: typeof before) => r.series?.find((p) => p.at === "2026-10-05T00:00:00.000Z");
    expect(oct5(before)).toMatchObject({ scope: 1, done: 1 });

    vault.deleteConcept("t");
    expect(vault.taskEvents().map((e) => e.kind)).toEqual(["created", "scope_added", "taken", "done", "deleted"]);
    const after = vault.burndown({ scope: "auth", from: "2026-10-01" }, now);
    expect(oct5(after)).toMatchObject({ scope: 1, done: 1 }); // October unchanged
    // Gone from the moment it was deleted (the deleted event uses the real clock).
    expect(vault.burndown({ scope: "auth" }, new Date(Date.now() + 60_000)).totals.scope).toBe(0);
  });

  it("a stale claim re-taken under the same label records a fresh take", async () => {
    const { vault, fake } = await freshVault();
    await vault.upsertConcept({ id: "t", title: "T", body: "", type: "task", taskStatus: "open" });
    await vault.takeTask({ id: "t" }); // default label "an agent"
    // Age the claim past the reclaim TTL, then reclaim with the same default label.
    const old = new Date(Date.now() - 47 * 3_600_000).toISOString();
    fake.db.prepare(`UPDATE concept SET taken_at = ? WHERE id = 't'`).run(old);
    fake.db.prepare(`UPDATE task_event SET at = ? WHERE kind = 'taken'`).run(old);
    await vault.takeTask({ id: "t" });
    const taken = vault.taskEvents().filter((e) => e.kind === "taken");
    expect(taken).toHaveLength(2);
    expect(taken.map((e) => e.by)).toEqual(["an agent", "an agent"]);
    const r = vault.burndown({ staleAfterHours: 24 });
    expect(r.stale).toEqual([]);
  });
});

/** The concept's outgoing edges as `relation:to`, as the DO stores them. */
async function storedEdges(vault: VaultDO, id: string): Promise<string[]> {
  const g = await vault.graph();
  return g.edges.filter((e) => e.from === id).map((e) => `${e.relation}:${e.to}`).sort();
}
