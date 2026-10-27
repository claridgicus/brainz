import { describe, expect, it } from "vitest";
import {
  advanceSweep,
  diaryEntry,
  extractOutcome,
  isEmptySweep,
  parseRemResponse,
  planDeep,
  startSweep,
  type DreamConcept,
  type DreamLlm,
  type DreamSnapshot,
  type DreamSweepState,
} from "../src/dream.js";

const T0 = "2026-10-01T00:00:00.000Z";
const NOW = "2026-10-27T03:00:00.000Z";

function concept(id: string, extra: Partial<DreamConcept> = {}): DreamConcept {
  return {
    id,
    title: id.replace(/-/g, " "),
    type: "feature",
    status: "active",
    tags: [],
    codeAreas: [],
    relations: {},
    body: `About ${id}.\n`,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

/** A small vault: two duplicate "session refresh" notes, referrers, and a done task. */
function seeded(): DreamSnapshot {
  return {
    concepts: [
      concept("auth", { type: "domain", body: "Authentication domain.\n" }),
      concept("session-refresh", {
        title: "Session refresh",
        body: "Session tokens rotate every 15 minutes so users stay signed in.\n",
        relations: { part_of: ["auth"] },
        tags: ["auth"],
      }),
      concept("session-refreshing", {
        title: "Session Refresh",
        body: "Tokens are rotated on a 15 minute schedule.\n",
        codeAreas: ["src/session.ts"],
      }),
      concept("login-flow", {
        type: "workflow",
        body: "Sign in, then [[session-refreshing|refresh]] keeps you in.\n",
        relations: { depends_on: ["session-refreshing"] },
      }),
      concept("task-rate-limit", {
        type: "task",
        taskStatus: "done",
        doneAt: "2026-10-20T00:00:00.000Z",
        body: "Add a rate limit.\n\n## Outcome\n\nSignups are capped at 5 per IP per hour.\n",
        codeAreas: ["src/rate-limit.ts"],
      }),
    ],
  };
}

function fakeLlm(response: unknown): DreamLlm & { calls: number } {
  return {
    name: "fake",
    calls: 0,
    async complete() {
      this.calls++;
      return typeof response === "string" ? response : JSON.stringify(response);
    },
  };
}

async function runToDeep(
  snapshot: DreamSnapshot,
  llm: DreamLlm | null,
  since: string | null = null,
): Promise<DreamSweepState> {
  let state = startSweep({ id: "dream-1", trigger: "manual", now: NOW, since, snapshot });
  for (let i = 0; i < 20 && state.phase !== "deep"; i++) {
    state = await advanceSweep(state, snapshot, { llm });
  }
  return state;
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
  links: [],
  contradictions: [],
  themes: ["session lifetime"],
};

describe("light phase", () => {
  it("stages lexical duplicates, outcomes and hygiene counts", async () => {
    const state = await runToDeep(seeded(), null);
    expect(state.light.duplicates).toEqual([
      { a: "session-refresh", b: "session-refreshing", score: 1, basis: "lexical" },
    ]);
    expect(state.light.outcomes.map((o) => o.task)).toEqual(["task-rate-limit"]);
    expect(state.light.outcomes[0].outcome).toBe("Signups are capped at 5 per IP per hour.");
    expect(state.light.orphans).toBe(1); // the task
    expect(state.light.missingCodeAreas).toBe(3);
  });

  it("prefers embedding cosine when both concepts have vectors", async () => {
    const snap = seeded();
    const v = new Map<string, Float32Array>([
      ["auth", Float32Array.from([1, 0, 0])],
      ["login-flow", Float32Array.from([0.99, 0.05, 0])],
      ["session-refresh", Float32Array.from([0, 1, 0])],
      ["session-refreshing", Float32Array.from([0, 0, 1])],
    ]);
    snap.vector = (id) => v.get(id) ?? null;
    const state = await runToDeep(snap, null);
    expect(state.light.duplicates).toEqual([
      { a: "auth", b: "login-flow", score: expect.any(Number), basis: "embedding" },
    ]);
  });

  it("only considers changes since the previous sweep", async () => {
    const state = startSweep({
      id: "d",
      trigger: "alarm",
      now: NOW,
      since: "2026-10-25T00:00:00.000Z",
      snapshot: seeded(),
    });
    expect(state.light.changed).toEqual([]);
    expect(isEmptySweep(state)).toBe(true);
  });

  it("chunks duplicate scanning by lightBatch", async () => {
    const snap = seeded();
    let state = startSweep({ id: "d", trigger: "alarm", now: NOW, since: null, snapshot: snap });
    state = await advanceSweep(state, snap, { llm: null, options: { lightBatch: 2 } });
    expect(state.phase).toBe("light");
    expect(state.light.cursor).toBe(2);
  });

  it("extracts the last Outcome section", () => {
    expect(extractOutcome("x\n## Outcome\n\nfirst\n\n## Outcome\n\nsecond\n")).toBe("second");
    expect(extractOutcome("no outcome")).toBeNull();
  });
});

describe("REM phase", () => {
  it("is skipped without an LLM and deep is skipped too", async () => {
    const snap = seeded();
    const state = await runToDeep(snap, null);
    expect(state.rem.status).toBe("skipped");
    const entry = diaryEntry(state, null, NOW);
    expect(entry.status).toBe("light-only");
    expect(entry.deep.status).toBe("skipped");
    expect(entry.markdown).toContain("REM:** skipped");
  });

  it("collects proposals and tolerates prose around the JSON", async () => {
    const llm = fakeLlm("Sure!\n```json\n" + JSON.stringify(PROPOSALS) + "\n```");
    const state = await runToDeep(seeded(), llm);
    expect(state.rem.status).toBe("ok");
    expect(llm.calls).toBe(1);
    expect(state.rem.proposals.merges).toHaveLength(1);
    expect(state.rem.proposals.themes).toEqual(["session lifetime"]);
  });

  it("counts unparseable responses and marks llm errors as skipped", async () => {
    expect(parseRemResponse("no json here")).toBeNull();
    const garbled = await runToDeep(seeded(), fakeLlm("nope"));
    expect(garbled.rem.unparseable).toBe(1);
    const failing: DreamLlm = {
      name: "boom",
      async complete() {
        throw new Error("model down");
      },
    };
    const failed = await runToDeep(seeded(), failing);
    expect(failed.rem.status).toBe("skipped");
    expect(failed.rem.reason).toContain("model down");
  });
});

describe("deep phase", () => {
  it("merges duplicates with edges redirected and promotes outcomes", async () => {
    const snap = seeded();
    const state = await runToDeep(snap, fakeLlm(PROPOSALS));
    const plan = planDeep(state, snap, { now: NOW });
    expect(plan.status).toBe("apply");
    const byId = new Map(plan.ops.map((op) => [op.id, op]));

    const dropped = byId.get("session-refreshing")!;
    expect(dropped.after).toBeNull();
    expect(dropped.before?.title).toBe("Session Refresh");

    const keep = byId.get("session-refresh")!.after!;
    expect(keep.codeAreas).toEqual(["src/session.ts"]);
    expect(keep.body).toContain("## Merged from Session Refresh (session-refreshing)");
    expect(keep.relations).toEqual({ part_of: ["auth"] });

    const login = byId.get("login-flow")!.after!;
    expect(login.relations).toEqual({ depends_on: ["session-refresh"] });
    expect(login.body).toContain("[[session-refresh|refresh]]");

    const promoted = byId.get("signup-rate-limit")!;
    expect(promoted.before).toBeNull();
    expect(promoted.after).toMatchObject({
      type: "constraint",
      relations: { derived_from: ["task-rate-limit"] },
      tags: ["dreamed"],
      codeAreas: ["src/rate-limit.ts"],
    });

    expect(plan.touched).toBe(3);
    const entry = diaryEntry(state, plan, NOW);
    expect(entry.status).toBe("applied");
    expect(entry.deep).toMatchObject({ merged: 1, promoted: 1 });
    expect(entry.markdown).toContain("1 merged, 1 promoted");
  });

  it("gates proposals: unstaged merges, low confidence, unknown types, existing ids", async () => {
    const snap = seeded();
    const state = await runToDeep(
      snap,
      fakeLlm({
        merges: [
          { keep: "auth", drop: "login-flow", confidence: 0.99 },
          { keep: "session-refresh", drop: "session-refreshing", confidence: 0.5 },
        ],
        promotions: [
          { task: "task-rate-limit", title: "x", type: "banana", body: "b", confidence: 0.9 },
          { task: "task-rate-limit", title: "Auth", type: "constraint", body: "b", confidence: 0.9 },
          { task: "not-a-task", title: "y", type: "constraint", body: "b", confidence: 0.9 },
        ],
        links: [{ from: "auth", to: "ghost", relation: "related_to", confidence: 0.9 }],
        contradictions: [],
      }),
    );
    const plan = planDeep(state, snap, { now: NOW });
    expect(plan.status).toBe("nothing");
    expect(plan.ops).toEqual([]);
    expect(plan.rejected).toEqual({
      "not-staged": 2,
      "below-threshold": 1,
      "bad-type": 1,
      exists: 1,
      missing: 1,
    });
  });

  it("files contradictions as open tasks instead of picking a side", async () => {
    const snap = seeded();
    const state = await runToDeep(
      snap,
      fakeLlm({
        contradictions: [
          { ids: ["session-refresh", "login-flow"], summary: "They disagree on TTL.", confidence: 0.8 },
        ],
      }),
    );
    const plan = planDeep(state, snap, { now: NOW });
    expect(plan.touched).toBe(0);
    const task = plan.ops[0].after!;
    expect(task).toMatchObject({
      type: "task",
      taskStatus: "open",
      tags: ["dream", "contradiction"],
      relations: { related_to: ["login-flow", "session-refresh"] },
    });
  });

  it("rejects a sweep that would touch more than the loss threshold", async () => {
    const snap = seeded();
    const state = await runToDeep(snap, fakeLlm(PROPOSALS));
    const plan = planDeep(state, snap, {
      now: NOW,
      options: { minTouchAllowance: 1, maxTouchFraction: 0.2 },
    });
    expect(plan.status).toBe("rejected");
    expect(plan.ops).toEqual([]);
    const entry = diaryEntry(state, plan, NOW);
    expect(entry.status).toBe("rejected");
    expect(entry.markdown).toContain("Nothing was written");
  });

  it("does not mutate the snapshot", async () => {
    const snap = seeded();
    const before = JSON.stringify(snap.concepts);
    const state = await runToDeep(snap, fakeLlm(PROPOSALS));
    planDeep(state, snap, { now: NOW });
    expect(JSON.stringify(snap.concepts)).toBe(before);
  });
});
