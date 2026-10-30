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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultDO } from "./vault-do";
import { VAULT_ID_HEADER } from "./do-helpers";
import { KILL_SWITCH_FLAG, recordDreamSpend, saveLlmKey, utcDay } from "./dream-budget";
import { fakeD1, seedOwner } from "./fake-d1.testutil";

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
  // Worker → DO calls carry the vault id; the DO bills dreams to its owner.
  await vault.fetch(
    new Request("https://vault-do/stats", { method: "POST", headers: { [VAULT_ID_HEADER]: "v1" }, body: "{}" }),
  );
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

/** Env with a D1 control plane where u1 owns vault v1 (the seeded vault). */
function billed(extra: Record<string, unknown> = {}) {
  const d1 = fakeD1();
  seedOwner(d1, "u1", "v1");
  return { d1, env: { DB: d1, BYOK_ENCRYPTION_KEY: "test-secret", ...extra } };
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
    const { vault, db } = await seededVault(billed({ AI: fakeAi() }).env);
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
    const { vault } = await seededVault(billed({ AI: fakeAi() }).env);
    const run = await vault.dreamRun();
    await new Promise((r) => setTimeout(r, 2));
    await vault.upsertConcept({ id: "login-flow", title: "Login flow", body: "Rewritten by an agent." });
    const res = await vault.dreamRevert(run.id!);
    expect(res).toMatchObject({ reverted: false, conflicts: ["login-flow"] });
  });

  it("rejects a sweep over the loss threshold and writes nothing", async () => {
    const { vault, db } = await seededVault(billed({ AI: fakeAi() }).env);
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
    const { vault } = await seededVault(billed({ AI: ai }).env);
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

describe("VaultDO dreaming spend controls", () => {
  // A frozen clock: the ledger's UTC day can't roll over mid-test, and every
  // sweep starts and finishes at the same instant, so a dream's own writes are
  // not "changed since" its start (with a ticking clock the next sweep stages
  // them and is not idle — the flake this replaced).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("meters Workers AI spend to the owner's daily ledger and reports it in status", async () => {
    const { d1, env } = billed({ AI: fakeAi() });
    const { vault } = await seededVault(env);
    const before = await vault.dreamStatus();
    expect(dreamOutputSchema.safeParse(before).success).toBe(true);
    expect(before).toMatchObject({
      provider: "workers-ai",
      killSwitch: "off",
      spend: { usd: 0, capUsd: 1, remainingUsd: 1 },
    });
    const run = await vault.dreamRun();
    expect(run.entry?.status).toBe("applied");
    const row = d1.db.prepare(`SELECT usd_micros, calls FROM dream_spend WHERE user_id = 'u1'`).get() as {
      usd_micros: number;
      calls: number;
    };
    expect(row.calls).toBe(1);
    expect(row.usd_micros).toBeGreaterThan(0);
    expect((await vault.dreamStatus()).spend?.usd).toBeCloseTo(row.usd_micros / 1e6, 6);
  });

  it("over budget: light-only with reason budget, no LLM call, and REM is retried next sweep", async () => {
    const ai = fakeAi();
    const { d1, env } = billed({ AI: ai });
    await recordDreamSpend(d1, "u1", utcDay(new Date()), 1, 10);
    const { vault, db } = await seededVault(env);
    const before = dump(db);
    const run = await vault.dreamRun();
    expect(run.entry).toMatchObject({ status: "light-only", rem: { status: "skipped", calls: 0 } });
    expect(run.entry?.rem.reason).toMatch(/^budget: /);
    expect(run.entry?.markdown).toContain("budget");
    expect(ai.calls.filter((m) => !m.includes("bge"))).toEqual([]);
    expect(dump(db)).toEqual(before);

    // Nothing changed, but REM is owed: the next sweep re-stages the same material.
    d1.db.prepare(`DELETE FROM dream_spend`).run();
    const retry = await vault.dreamRun();
    expect(retry.status).toBe("done");
    expect(retry.entry).toMatchObject({ status: "applied", deep: { merged: 1, promoted: 1 } });
    // Once REM ran, the backlog is cleared.
    expect((await vault.dreamRun()).status).toBe("idle");
  });

  it("kill switch: REM skipped as disabled; status reports it", async () => {
    const ai = fakeAi();
    const { d1, env } = billed({ AI: ai });
    d1.db.prepare(`INSERT INTO control_flag (key, value, updated_at) VALUES (?, 'workers-ai', 0)`).run(KILL_SWITCH_FLAG);
    const { vault } = await seededVault(env);
    expect(await vault.dreamStatus()).toMatchObject({ killSwitch: "workers-ai", provider: null, llm: null });
    const run = await vault.dreamRun();
    expect(run.entry?.rem.reason).toMatch(/^disabled: /);
    expect(run.entry?.status).toBe("light-only");
    expect(ai.calls.filter((m) => !m.includes("bge"))).toEqual([]);
  });

  it("BYOK: a failing key is recorded as llm-error and never falls back to Workers AI", async () => {
    const ai = fakeAi();
    const { d1, env } = billed({ AI: ai });
    await saveLlmKey(d1, "test-secret", "u1", { provider: "anthropic", apiKey: "sk-ant-api03-badbadbadbad" });
    const { vault } = await seededVault(env);
    vault.dreamFetch = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const status = await vault.dreamStatus();
    expect(status.provider).toBe("byok:anthropic");
    expect(dreamOutputSchema.safeParse(status).success).toBe(true);
    const run = await vault.dreamRun();
    expect(run.entry?.rem.status).toBe("skipped");
    expect(run.entry?.rem.reason).toMatch(/^llm-error: /);
    expect(ai.calls.filter((m) => !m.includes("bge"))).toEqual([]);
    expect(d1.db.prepare(`SELECT COUNT(*) AS n FROM dream_spend`).get()).toEqual({ n: 0 });
  });
});

describe("VaultDO per-vault dreaming settings", () => {
  it("configure stores every setting, clamped, and status reports them", async () => {
    const { vault } = await seededVault({});
    const status = await vault.dreamConfigure({
      mode: "propose",
      runHourUtc: 3,
      phases: { links: false },
      thresholds: { merge: 0.9 },
      caps: { maxMerges: 2 },
      lossRail: { maxTouchFraction: 0.9, minTouchAllowance: 1 },
      llm: { provider: "byok", model: "claude-sonnet-5-5" },
    });
    expect(dreamOutputSchema.safeParse(status).success).toBe(true);
    expect(status.settings).toMatchObject({
      enabled: true,
      cadenceHours: 24,
      mode: "propose",
      runHourUtc: 3,
      phases: { merges: true, links: false },
      thresholds: { merge: 0.9, promote: 0.7 },
      caps: { maxMerges: 2, maxLinks: 10 },
      // Stricter only: the fraction is clamped back to the 0.2 floor.
      lossRail: { maxTouchFraction: 0.2, minTouchAllowance: 1 },
      llm: { provider: "byok", model: "claude-sonnet-5-5" },
    });
    // The next nightly run lands on the preferred hour.
    expect(new Date(status.nextDreamAt!).getUTCHours()).toBe(3);
    // A later patch merges field by field.
    const next = await vault.dreamConfigure({ phases: { merges: false }, runHourUtc: null });
    expect(next.settings.phases).toMatchObject({ merges: false, links: false });
    expect(next.settings.runHourUtc).toBeNull();
    expect(next.settings.caps.maxMerges).toBe(2);
  });

  it("settings flow into the sweep: a stricter loss rail rejects the dream", async () => {
    const { vault, db } = await seededVault(billed({ AI: fakeAi() }).env);
    const before = dump(db);
    await vault.dreamConfigure({ lossRail: { minTouchAllowance: 1 } });
    const run = await vault.dreamRun();
    expect(run.entry?.status).toBe("rejected");
    expect(dump(db)).toEqual(before);
  });

  it("light-only mode never calls the LLM", async () => {
    const ai = fakeAi();
    const { vault, db } = await seededVault(billed({ AI: ai }).env);
    const before = dump(db);
    const status = await vault.dreamConfigure({ mode: "light-only" });
    expect(status).toMatchObject({ llm: null, provider: null });
    const run = await vault.dreamRun();
    expect(run.entry).toMatchObject({ status: "light-only", mode: "light-only" });
    expect(run.entry?.rem.reason).toBe("light-only mode");
    expect(ai.calls.filter((m) => !m.includes("bge"))).toEqual([]);
    expect(dump(db)).toEqual(before);
  });

  it("propose → apply: nothing written until approved, then the approved subset applies and reverts", async () => {
    const { vault, db } = await seededVault(billed({ AI: fakeAi() }).env);
    const before = dump(db);
    await vault.dreamConfigure({ mode: "propose" });
    const run = await vault.dreamRun();
    expect(dreamOutputSchema.safeParse(run).success).toBe(true);
    expect(run.entry?.status).toBe("proposed");
    expect(run.entry?.proposals?.map((p) => [p.n, p.kind])).toEqual([
      [0, "merge"],
      [1, "promote"],
    ]);
    expect(dump(db)).toEqual(before);
    await expect(vault.dreamRevert(run.id!)).rejects.toThrow(/still proposed/);

    const res = await vault.dreamApply(run.id!, [0]);
    expect(dreamOutputSchema.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ status: "applied", applied: 1, rejected: 1 });
    expect(vault.getConcept("session-refreshing").concept).toBeNull();
    expect(vault.getConcept("signup-rate-limit").concept).toBeNull();
    expect(vault.dreamDiary(1).entries[0].proposals?.map((p) => p.decision)).toEqual(["approved", "rejected"]);
    await expect(vault.dreamApply(run.id!)).rejects.toThrow(/no pending proposals/);

    expect(await vault.dreamRevert(run.id!)).toMatchObject({ reverted: true });
    expect(dump(db)).toEqual(before);
  });

  it("reject all dismisses a proposed dream", async () => {
    const { vault, db } = await seededVault(billed({ AI: fakeAi() }).env);
    const before = dump(db);
    await vault.dreamConfigure({ mode: "propose" });
    const run = await vault.dreamRun();
    const res = await vault.dreamApply(run.id!, []);
    expect(res).toMatchObject({ status: "dismissed", applied: 0, rejected: 2 });
    expect(dump(db)).toEqual(before);
  });

  it("llm provider preference: workers-ai skips the owner's key; byok without a key never uses Workers AI", async () => {
    const ai = fakeAi();
    const { d1, env } = billed({ AI: ai });
    const { vault } = await seededVault(env);
    await vault.dreamConfigure({ llm: { provider: "byok" } });
    const status = await vault.dreamStatus();
    expect(status.provider).toBeNull();
    const run = await vault.dreamRun();
    expect(run.entry?.rem.reason).toMatch(/^no LLM provider available: /);
    expect(ai.calls.filter((m) => !m.includes("bge"))).toEqual([]);

    await saveLlmKey(d1, "test-secret", "u1", { provider: "anthropic", apiKey: "sk-ant-api03-goodgoodgood" });
    await vault.dreamConfigure({ llm: { provider: "workers-ai" } });
    expect((await vault.dreamStatus()).provider).toBe("workers-ai");
    await vault.dreamConfigure({ llm: { provider: "auto" } });
    expect((await vault.dreamStatus()).provider).toBe("byok:anthropic");
  });
});

describe("VaultDO schema v8 migration", () => {
  it("adds dream.pending_json to a v7 vault and keeps its settings defaults", async () => {
    const fake = fakeState();
    new VaultDO(fake.state as never, {});
    await fake.ready();
    fake.db.exec(`ALTER TABLE dream DROP COLUMN pending_json`);
    fake.db.prepare(`UPDATE meta SET value = '7' WHERE key = 'schema_version'`).run();
    const vault = new VaultDO(fake.state as never, {});
    await fake.ready();
    const cols = fake.db.prepare(`PRAGMA table_info(dream)`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("pending_json");
    expect(fake.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toEqual({ value: "8" });
    expect((await vault.dreamStatus()).settings.mode).toBe("apply");
  });
});
