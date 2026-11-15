/**
 * Epics through the REAL VaultDO class over better-sqlite3 (same shim as
 * vault-do-burndown.test.ts): the v9 → v10 migration appends the `epic`
 * built-in, and the board's re-parent (setMembership with type "epic") swaps
 * a task's epic from stored relations.
 */
import Database from "better-sqlite3";
import { BUILTIN_CONCEPT_TYPES } from "@brainz/contracts";
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

describe("VaultDO schema v10 migration", () => {
  it("appends the epic built-in to a v9 vault's registry", async () => {
    const fake = fakeState();
    new VaultDO(fake.state as never, {});
    await fake.ready();
    fake.db.exec(`DELETE FROM concept_type WHERE key = 'epic'`);
    fake.db.prepare(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`).run();

    const vault = new VaultDO(fake.state as never, {});
    await fake.ready();
    expect(fake.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({ value: "11" });
    const types = vault.listTypes().types;
    const builtin = BUILTIN_CONCEPT_TYPES.find((t) => t.key === "epic");
    // After the 13 older built-ins (0..12).
    expect(types.find((t) => t.key === "epic")).toMatchObject({ builtin: true, color: builtin?.color, order: 13 });
    expect(types).toHaveLength(BUILTIN_CONCEPT_TYPES.length);
  });

  it("keeps a custom type that already took the epic key", async () => {
    const fake = fakeState();
    new VaultDO(fake.state as never, {});
    await fake.ready();
    fake.db.exec(`DELETE FROM concept_type WHERE key = 'epic'`);
    fake.db
      .prepare(`INSERT INTO concept_type (key, label, color, weight, sort_order, hidden, builtin) VALUES ('epic', 'Saga', '#123456', 50, 13, 0, 0)`)
      .run();
    fake.db.prepare(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`).run();
    const vault = new VaultDO(fake.state as never, {});
    await fake.ready();
    expect(vault.listTypes().types.find((t) => t.key === "epic")).toMatchObject({
      label: "Saga",
      color: "#123456",
      builtin: false,
    });
  });

  it("a fresh vault seeds epic with the other built-ins", async () => {
    const { vault } = await freshVault();
    expect(vault.listTypes().types.map((t) => t.key)).toEqual(BUILTIN_CONCEPT_TYPES.map((t) => t.key));
  });
});

describe("VaultDO epic re-parent (board drag to another epic lane)", () => {
  async function seeded() {
    const { vault } = await freshVault();
    await vault.upsertConcept({ id: "auth", title: "Auth", body: "", type: "domain" });
    await vault.upsertConcept({ id: "e1", title: "Epic 1", body: "", type: "epic" });
    await vault.upsertConcept({ id: "e2", title: "Epic 2", body: "", type: "epic" });
    await vault.upsertConcept({
      id: "t",
      title: "T",
      body: "",
      type: "task",
      taskStatus: "open",
      relations: { part_of: ["auth", "e1"] },
    });
    return vault;
  }
  const edgesOf = async (vault: VaultDO, id: string) =>
    (await vault.graph()).edges
      .filter((e) => e.from === id)
      .map((e) => `${e.relation}:${e.to}`)
      .sort();

  it("swaps the epic and keeps the domain link", async () => {
    const vault = await seeded();
    vault.setMembership({ id: "t", type: "epic", target: "e2" });
    expect(await edgesOf(vault, "t")).toEqual(["part_of:auth", "part_of:e2"]);
  });

  it("keeps a link added while the client's graph was stale", async () => {
    const vault = await seeded();
    // An agent links the task to a spec after the board last fetched the graph.
    await vault.upsertConcept({
      id: "t",
      title: "T",
      body: "",
      type: "task",
      taskStatus: "open",
      relations: { part_of: ["auth", "e1"], governed_by: ["spec-x"] },
    });
    vault.setMembership({ id: "t", type: "epic", target: "e2" });
    expect(await edgesOf(vault, "t")).toEqual(["governed_by:spec-x", "part_of:auth", "part_of:e2"]);
  });

  it("clears the epic (drop on the No epic lane) and rejects a non-epic target", async () => {
    const vault = await seeded();
    vault.setMembership({ id: "t", type: "epic", target: null });
    expect(await edgesOf(vault, "t")).toEqual(["part_of:auth"]);
    expect(() => vault.setMembership({ id: "t", type: "epic", target: "auth" })).toThrow(/not a epic/);
  });

  it('relation "any" clears a realizes epic the board never saw (stale graph) when moving', async () => {
    const vault = await seeded();
    // An agent adds `realizes: e3` after the board loaded the task in e1.
    await vault.upsertConcept({ id: "e3", title: "Epic 3", body: "", type: "epic" });
    await vault.link({ from: "t", to: "e3", relation: "realizes" });
    vault.setMembership({ id: "t", relation: "any", type: "epic", target: "e2" });
    expect(await edgesOf(vault, "t")).toEqual(["part_of:auth", "part_of:e2"]);
    // ...and "No epic" clears every stored epic link too.
    await vault.link({ from: "t", to: "e3", relation: "realizes" });
    vault.setMembership({ id: "t", relation: "any", type: "epic", target: null });
    expect(await edgesOf(vault, "t")).toEqual(["part_of:auth"]);
  });

  it('relation "any" refuses No epic (409, naming it, nothing written) while an epic is inherited', async () => {
    const vault = await seeded();
    // t is directly in e1 AND realizes a feature that is part_of e2.
    await vault.upsertConcept({
      id: "pay",
      title: "Pay button",
      body: "",
      type: "feature",
      relations: { part_of: ["e2"] },
    });
    await vault.link({ from: "t", to: "pay", relation: "realizes" });
    const before = await edgesOf(vault, "t");
    const res = await vault.fetch(
      new Request("https://vault-do/setMembership", {
        method: "POST",
        body: JSON.stringify({ id: "t", relation: "any", type: "epic", target: null }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('"Epic 2" (e2)');
    expect(await edgesOf(vault, "t")).toEqual(before);
    // Moving to another epic is still fine: the direct part_of is nearer.
    vault.setMembership({ id: "t", relation: "any", type: "epic", target: "e1" });
    expect(await edgesOf(vault, "t")).toEqual(["part_of:auth", "part_of:e1", "realizes:pay"]);
  });
});
