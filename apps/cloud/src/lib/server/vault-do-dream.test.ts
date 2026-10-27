/**
 * Dreaming end to end through the REAL VaultDO class: its `ctx.storage.sql` is
 * a better-sqlite3 database behind a minimal SqlStorage shim (exec → cursor
 * with toArray/one), and the alarm API is an in-memory slot. Covers the
 * acceptance flow: seeded duplicates + task outcome → one `dream run` merges
 * (edges redirected) and promotes, writes a diary entry, and `dream revert`
 * restores the prior state exactly; the loss rail rejects; no AI ⇒ light only.
 */
import Database from "better-sqlite3";
import { dreamOutputSchema } from "@brainz/contracts";
import { describe, expect, it } from "vitest";
import { VaultDO } from "./vault-do";

function fakeState() {
  const db = new Database(":memory:");
  let alarm: number | null = null;
  let ready: Promise<unknown> = Promise.resolve();
  const sql = {
    exec(query: string, ...binds: unknown[]) {
      const stmt = db.prepare(query);
      const args = binds.map((b) => (b instanceof ArrayBuffer ? Buffer.from(b) : b));
      const rows = stmt.reader ? (stmt.all(...args) as Record<string, unknown>[]) : (stmt.run(...args), []);
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
      getAlarm: async () => alarm,
      setAlarm: async (t: number | Date) => {
        alarm = typeof t === "number" ? t : t.getTime();
      },
      deleteAlarm: async () => {
        alarm = null;
      },
      deleteAll: async () => {},
    },
    blockConcurrencyWhile(fn: () => Promise<unknown>) {
      ready = fn();
      return ready;
    },
  };
  return { state, ready: () => ready, alarm: () => alarm, db };
}

const PROPOSALS = {
  merges: [{ keep: "session-refresh", drop: "session-refreshing", confidence: 0.95 }],
  promotions: [
    {
      task: "task-rate-limit",
      title: "Signup rate limit",
      type: "constraint",
      body: "Signups are capped at 5 per IP per hour.",
      confidence: 0.9,
    },
  ],
  themes: ["session lifetime"],
};

/** Workers AI fake: embeddings fail (lexical duplicate detection), chat returns the proposals. */
function fakeAi(proposals: unknown = PROPOSALS) {
  return {
    calls: [] as string[],
    async run(model: string) {
      this.calls.push(model);
      if (model.includes("bge")) throw new Error("no embeddings in tests");
      return { response: JSON.stringify(proposals) };
    },
  };
}

async function seededVault(env: unknown) {
  const fake = fakeState();
  const vault = new VaultDO(fake.state as never, env);
  await fake.ready();
  await vault.upsertConcept({ id: "auth", title: "Auth", type: "domain", body: "Authentication domain." });
  await vault.upsertConcept({
    id: "session-refresh",
    title: "Session refresh",
    type: "feature",
    body: "Session tokens rotate every 15 minutes.",
    relations: { part_of: ["auth"] },
  });
  await vault.upsertConcept({
    id: "session-refreshing",
    title: "Session Refresh",
    type: "feature",
    body: "Tokens rotate on a 15 minute schedule.",
    codeAreas: ["src/session.ts"],
  });
  await vault.upsertConcept({
    id: "login-flow",
    title: "Login flow",
    type: "workflow",
    body: "Sign in, then [[session-refreshing]] keeps you in.",
    relations: { depends_on: ["session-refreshing"] },
  });
  await vault.upsertConcept({
    id: "task-rate-limit",
    title: "Rate limit signups",
    type: "task",
    body: "Add a rate limit.",
  });
  await vault.completeTask({ id: "task-rate-limit", outcome: "Signups are capped at 5 per IP per hour." });
  return { vault, ...fake };
}

/** Everything a revert must restore: concept rows + edges (embeddings/FTS are derived). */
function dump(db: Database.Database) {
  return {
    concepts: db.prepare("SELECT * FROM concept ORDER BY id").all(),
    edges: db.prepare("SELECT * FROM edge ORDER BY from_id, to_id, relation").all(),
  };
}

describe("VaultDO dreaming", () => {
  it("arms the nightly alarm on construction", async () => {
    const { alarm, vault } = await seededVault({});
    expect(alarm()).not.toBeNull();
    const status = await vault.dreamStatus();
    expect(dreamOutputSchema.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({ enabled: true, cadenceHours: 24, llm: null, inFlight: null });
  });

  it("one run merges duplicates, redirects edges, promotes an outcome; revert restores exactly", async () => {
    const { vault, db } = await seededVault({ AI: fakeAi() });
    const before = dump(db);

    const run = await vault.dreamRun();
    expect(dreamOutputSchema.safeParse(run).success).toBe(true);
    expect(run.status).toBe("done");
    expect(run.entry?.status).toBe("applied");
    expect(run.entry?.deep).toMatchObject({ merged: 1, promoted: 1 });

    expect(vault.getConcept("session-refreshing").concept).toBeNull();
    const keep = vault.getConcept("session-refresh").concept!;
    expect(keep.codeAreas).toEqual(["src/session.ts"]);
    expect(keep.neighbors).toContainEqual(
      expect.objectContaining({ id: "login-flow", relation: "depends_on", direction: "in" }),
    );
    const edges = db.prepare("SELECT from_id, to_id, relation FROM edge").all();
    expect(edges).not.toContainEqual(expect.objectContaining({ to_id: "session-refreshing" }));
    expect(vault.getConcept("signup-rate-limit").concept).toMatchObject({
      type: "constraint",
      tags: ["dreamed"],
    });
    expect((await vault.search({ query: "capped", mode: "keyword" })).hits.map((h) => h.id)).toContain(
      "signup-rate-limit",
    );

    const diary = vault.dreamDiary(5);
    expect(dreamOutputSchema.safeParse(diary).success).toBe(true);
    expect(diary.entries[0].id).toBe(run.id);
    expect(vault.stats().lastDreamAt).toBe(run.entry?.startedAt);

    const reverted = await vault.dreamRevert(run.id!);
    expect(reverted).toEqual({ id: run.id, reverted: true, restored: 4, conflicts: [] });
    expect(dump(db)).toEqual(before);
    expect(vault.dreamDiary(1).entries[0]).toMatchObject({ status: "reverted" });
    await expect(vault.dreamRevert(run.id!)).rejects.toThrow(/already reverted/);
  });

  it("refuses to revert over later edits", async () => {
    const { vault } = await seededVault({ AI: fakeAi() });
    const run = await vault.dreamRun();
    await new Promise((r) => setTimeout(r, 2));
    await vault.upsertConcept({ id: "login-flow", title: "Login flow", body: "Rewritten by an agent." });
    const res = await vault.dreamRevert(run.id!);
    expect(res).toMatchObject({ reverted: false, conflicts: ["login-flow"] });
  });

  it("rejects a sweep over the loss threshold and writes nothing", async () => {
    const { vault, db } = await seededVault({ AI: fakeAi() });
    vault.dreamOptions = { minTouchAllowance: 1 };
    const before = dump(db).concepts;
    const run = await vault.dreamRun();
    expect(run.entry?.status).toBe("rejected");
    expect(run.entry?.markdown).toContain("loss threshold");
    expect(dump(db).concepts).toEqual(before);
  });

  it("without an AI binding: diary entry with REM/deep skipped, vault untouched", async () => {
    const { vault, db } = await seededVault({});
    const before = dump(db);
    const run = await vault.dreamRun();
    expect(run.entry).toMatchObject({
      status: "light-only",
      rem: { status: "skipped" },
      deep: { status: "skipped" },
      light: { duplicates: 1, outcomes: 1 },
    });
    expect(dump(db)).toEqual(before);
    // Nothing changed since: the next sweep is idle and writes no entry.
    expect((await vault.dreamRun()).status).toBe("idle");
    expect(vault.dreamDiary().count).toBe(1);
  });

  it("chunks a sweep across alarm invocations with a checkpoint", async () => {
    const ai = fakeAi();
    const { vault } = await seededVault({ AI: ai });
    vault.dreamOptions = { lightBatch: 1 };
    await vault.alarm();
    const mid = await vault.dreamStatus();
    expect(mid.inFlight).toMatchObject({ phase: "light" });
    for (let i = 0; i < 10 && (await vault.dreamStatus()).inFlight; i++) await vault.alarm();
    const done = await vault.dreamStatus();
    expect(done.inFlight).toBeNull();
    expect(done.lastEntry).toMatchObject({ trigger: "alarm", status: "applied" });
  });

  it("configure turns dreaming off (no alarm) and clamps the cadence", async () => {
    const { vault, alarm } = await seededVault({});
    const off = await vault.dreamConfigure({ enabled: false, cadenceHours: 500 });
    expect(off).toMatchObject({ enabled: false, cadenceHours: 168, nextDreamAt: null });
    expect(alarm()).toBeNull();
    const on = await vault.dreamConfigure({ enabled: true });
    expect(on.nextDreamAt).not.toBeNull();
  });
});
