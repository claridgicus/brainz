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
