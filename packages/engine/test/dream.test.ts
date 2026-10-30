import { describe, expect, it } from "vitest";
import {
  DREAM_DEFAULTS,
  DREAM_SETTINGS_DEFAULTS,
  advanceSweep,
  decideEntry,
  diaryEntry,
  dreamOptionsFromSettings,
  nextDreamDue,
  normalizeDreamSettings,
  patchDreamSettings,
  remChunkPrompt,
  selectProposals,
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

  it("records the host's skip reason (spend cap / kill switch)", async () => {
    const snap = seeded();
    let state = startSweep({ id: "d", trigger: "alarm", now: NOW, since: null, snapshot: snap });
    while (state.phase !== "deep") {
      state = await advanceSweep(state, snap, { llm: null, skipReason: "budget: cap reached" });
    }
    expect(state.rem).toMatchObject({ status: "skipped", reason: "budget: cap reached", calls: 0 });
    expect(diaryEntry(state, null, NOW).markdown).toContain("budget: cap reached");
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

describe("per-vault settings", () => {
  it("defaults reproduce today's engine options", () => {
    const o = dreamOptionsFromSettings(normalizeDreamSettings(undefined));
    expect(o).toMatchObject({
      minMergeConfidence: DREAM_DEFAULTS.minMergeConfidence,
      minPromoteConfidence: DREAM_DEFAULTS.minPromoteConfidence,
      minLinkConfidence: DREAM_DEFAULTS.minLinkConfidence,
      minContradictionConfidence: DREAM_DEFAULTS.minContradictionConfidence,
      maxMerges: 5,
      maxPromotions: 5,
      maxLinks: 10,
      maxContradictions: 3,
      maxTouchFraction: 0.2,
      minTouchAllowance: 3,
    });
    expect(normalizeDreamSettings({})).toEqual(DREAM_SETTINGS_DEFAULTS);
  });

  it("clamps every field into bounds and never loosens the loss rail", () => {
    const s = normalizeDreamSettings({
      cadenceHours: 9999,
      runHourUtc: 30,
      mode: "yolo",
      phases: { merges: "no", links: false },
      thresholds: { merge: 0.1, promote: 2, link: "0.75" },
      caps: { maxMerges: 0, maxLinks: 500, maxContradictions: 2.6 },
      lossRail: { maxTouchFraction: 0.9, minTouchAllowance: 50 },
      llm: { provider: "gpt", model: "bad model!" },
    });
    expect(s.cadenceHours).toBe(168);
    expect(s.runHourUtc).toBe(23);
    expect(s.mode).toBe("apply");
    expect(s.phases).toEqual({ merges: true, promotions: true, links: false, contradictions: true });
    expect(s.thresholds).toEqual({ merge: 0.5, promote: 1, link: 0.75, contradiction: 0.6 });
    expect(s.caps).toEqual({ maxMerges: 1, maxPromotions: 5, maxLinks: 50, maxContradictions: 3 });
    expect(s.lossRail).toEqual({ maxTouchFraction: 0.2, minTouchAllowance: 3 });
    expect(s.llm).toEqual({ provider: "auto", model: null });
  });

  it("patches nested objects field by field; null clears run hour and model", () => {
    let s = patchDreamSettings(DREAM_SETTINGS_DEFAULTS, {
      mode: "propose",
      runHourUtc: 3,
      phases: { contradictions: false },
      caps: { maxLinks: 4 },
      lossRail: { maxTouchFraction: 0.05 },
      llm: { provider: "byok", model: "claude-sonnet-5-5" },
    });
    expect(s).toMatchObject({
      mode: "propose",
      runHourUtc: 3,
      phases: { merges: true, contradictions: false },
      caps: { maxLinks: 4, maxMerges: 5 },
      lossRail: { maxTouchFraction: 0.05, minTouchAllowance: 3 },
      llm: { provider: "byok", model: "claude-sonnet-5-5" },
    });
    s = patchDreamSettings(s, { runHourUtc: null, llm: { model: null } });
    expect(s.runHourUtc).toBeNull();
    expect(s.llm).toEqual({ provider: "byok", model: null });
    expect(dreamOptionsFromSettings(s)).toMatchObject({ maxLinks: 4, maxTouchFraction: 0.05 });
  });

  it("schedules at the preferred UTC hour when the cadence is at least a day", () => {
    const last = Date.parse("2026-10-27T15:20:00.000Z");
    const now = last + 1000;
    expect(new Date(nextDreamDue(last, now, { cadenceHours: 24, runHourUtc: null })).toISOString()).toBe(
      "2026-10-28T15:20:00.000Z",
    );
    expect(new Date(nextDreamDue(last, now, { cadenceHours: 24, runHourUtc: 3 })).toISOString()).toBe(
      "2026-10-29T03:00:00.000Z",
    );
    expect(new Date(nextDreamDue(last, now, { cadenceHours: 24, runHourUtc: 18 })).toISOString()).toBe(
      "2026-10-28T18:00:00.000Z",
    );
    // Below a day the run hour is ignored.
    expect(new Date(nextDreamDue(last, now, { cadenceHours: 6, runHourUtc: 3 })).toISOString()).toBe(
      "2026-10-27T21:20:00.000Z",
    );
  });

  it("a phase that is off is not asked of the model and its proposals are rejected", async () => {
    const snap = seeded();
    const state = await runToDeep(snap, fakeLlm(PROPOSALS));
    const options = { phases: { ...DREAM_DEFAULTS.phases, merges: false } };
    const prompt = JSON.parse(remChunkPrompt(state, snap, 0, options)) as Record<string, unknown>;
    expect(prompt.duplicates).toEqual([]);
    expect(prompt.off).toEqual(["merges"]);
    expect(JSON.parse(remChunkPrompt(state, snap, 0)).off).toBeUndefined();
    const plan = planDeep(state, snap, { now: NOW, options });
    expect(plan.rejected["phase-off"]).toBe(1);
    expect(plan.applied.map((a) => a.kind)).toEqual(["promote"]);
  });

  it("propose → apply: holds gated changes, then applies the approved subset", async () => {
    const snap = seeded();
    const state = await runToDeep(snap, fakeLlm(PROPOSALS));
    const plan = planDeep(state, snap, { now: NOW });
    const proposed = diaryEntry(state, plan, NOW, { mode: "propose" });
    expect(proposed.status).toBe("proposed");
    expect(proposed.mode).toBe("propose");
    expect(proposed.deep.status).toBe("proposed");
    expect(proposed.applied).toEqual([]);
    expect(proposed.proposals?.map((p) => [p.n, p.kind, p.decision])).toEqual([
      [0, "merge", "pending"],
      [1, "promote", "pending"],
    ]);
    expect(proposed.markdown).toContain("held for approval");

    // Approve only the promotion (#1), re-planned against the vault as it is now.
    const pending = { ...state, rem: { ...state.rem, proposals: selectProposals(plan.accepted, [1]) } };
    const replan = planDeep(pending, snap, { now: NOW });
    expect(replan.applied.map((a) => a.kind)).toEqual(["promote"]);
    const decided = decideEntry(proposed, replan, [1], NOW);
    expect(decided.status).toBe("applied");
    expect(decided.deep).toMatchObject({ status: "applied", promoted: 1, merged: 0 });
    expect(decided.proposals?.map((p) => p.decision)).toEqual(["rejected", "approved"]);
    expect(decided.decidedAt).toBe(NOW);

    const dismissed = decideEntry(proposed, null, [], NOW);
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.proposals?.every((p) => p.decision === "rejected")).toBe(true);
  });

  it("an approved proposal whose target has gone is re-gated, not forced", async () => {
    const snap = seeded();
    const state = await runToDeep(snap, fakeLlm(PROPOSALS));
    const plan = planDeep(state, snap, { now: NOW });
    const later: DreamSnapshot = {
      concepts: snap.concepts.filter((c) => c.id !== "session-refreshing"),
    };
    const pending = { ...state, rem: { ...state.rem, proposals: selectProposals(plan.accepted) } };
    const replan = planDeep(pending, later, { now: NOW });
    expect(replan.rejected.missing).toBe(1);
    expect(replan.applied.map((a) => a.kind)).toEqual(["promote"]);
  });
});
