import matter from "gray-matter";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Vault, type DreamLlm } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function note(fm: Record<string, unknown>, body: string): string {
  return matter.stringify(body, fm);
}

/** Seeded duplicates + a done task with an outcome. */
const FILES = {
  "auth.md": note({ id: "auth", title: "Auth", type: "domain" }, "Authentication domain.\n"),
  "session-refresh.md": note(
    { id: "session-refresh", title: "Session refresh", type: "feature", relations: { part_of: ["auth"] } },
    "Session tokens rotate every 15 minutes.\n",
  ),
  "session-refreshing.md": note(
    { id: "session-refreshing", title: "Session Refresh", type: "feature", code_areas: ["src/session.ts"], custom: "kept" },
    "Tokens rotate on a 15 minute schedule.\n",
  ),
  "login-flow.md": note(
    { id: "login-flow", title: "Login flow", type: "workflow", relations: { depends_on: ["session-refreshing"] } },
    "Sign in, then [[session-refreshing]] keeps you in.\n",
  ),
  "task-rate-limit.md": note(
    { id: "task-rate-limit", title: "Rate limit signups", type: "task", task_status: "done", done_at: "2026-10-20T00:00:00.000Z" },
    "Add a rate limit.\n\n## Outcome\n\nSignups are capped at 5 per IP per hour.\n",
  ),
};

async function makeVault(): Promise<{ vault: Vault; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "brainz-dream-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, "brainz.config.json"),
    JSON.stringify({ name: "test", embedding: { provider: "none" } }),
  );
  await mkdir(path.join(dir, "concepts"));
  for (const [name, content] of Object.entries(FILES)) {
    await writeFile(path.join(dir, "concepts", name), content);
  }
  const vault = await Vault.open(dir);
  cleanups.push(async () => vault.close());
  return { vault, dir };
}

const llm: DreamLlm = {
  name: "fake",
  async complete() {
    return JSON.stringify({
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
    });
  },
};

async function snapshotFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(path.join(dir, "concepts"))).sort()) {
    out[name] = await readFile(path.join(dir, "concepts", name), "utf8");
  }
  return out;
}

describe("Vault.dream (local)", () => {
  it("merges duplicates, redirects edges, promotes outcomes, and reverts exactly", async () => {
    const { vault, dir } = await makeVault();
    const before = await snapshotFiles(dir);
    const edgesBefore = vault.edges();

    const run = await vault.dream({ llm });
    expect(run.status).toBe("done");
    expect(run.entry?.status).toBe("applied");
    expect(run.entry?.deep).toMatchObject({ merged: 1, promoted: 1 });

    expect(vault.getConcept("session-refreshing")).toBeNull();
    const keep = vault.getConcept("session-refresh")!;
    expect(keep.codeAreas).toEqual(["src/session.ts"]);
    expect(vault.edges()).toContainEqual({ from: "login-flow", to: "session-refresh", relation: "depends_on" });
    expect(vault.edges().some((e) => e.to === "session-refreshing")).toBe(false);
    expect(vault.getConcept("signup-rate-limit")?.type).toBe("constraint");
    expect(vault.edges()).toContainEqual({ from: "signup-rate-limit", to: "task-rate-limit", relation: "derived_from" });

    const diary = await vault.dreamDiary();
    expect(diary.map((e) => e.id)).toEqual([run.id]);

    const reverted = await vault.revertDream(run.id!);
    expect(reverted).toMatchObject({ reverted: true, restored: 4, conflicts: [] });
    expect(await snapshotFiles(dir)).toEqual(before);
    expect(vault.edges()).toEqual(edgesBefore);
    expect((await vault.dreamDiary())[0].status).toBe("reverted");
    await expect(vault.revertDream(run.id!)).rejects.toThrow(/already reverted/);
  });

  it("refuses to revert over later edits", async () => {
    const { vault } = await makeVault();
    const run = await vault.dream({ llm });
    await vault.upsertConcept({ id: "session-refresh", title: "Session refresh", body: "Edited later.\n" });
    const res = await vault.revertDream(run.id!);
    expect(res).toMatchObject({ reverted: false, conflicts: ["session-refresh"] });
  });

  it("without an LLM writes a light-only diary entry and changes nothing", async () => {
    const { vault, dir } = await makeVault();
    const before = await snapshotFiles(dir);
    const run = await vault.dream();
    expect(run.entry?.status).toBe("light-only");
    expect(run.entry?.rem.status).toBe("skipped");
    expect(run.entry?.deep.status).toBe("skipped");
    expect(run.entry?.light.duplicates).toBe(1);
    expect(await snapshotFiles(dir)).toEqual(before);
    // Nothing changed since: the next sweep is empty and writes no entry.
    expect((await vault.dream()).status).toBe("idle");
    expect(await vault.dreamDiary()).toHaveLength(1);
  });

  it("rejects a sweep over the loss threshold", async () => {
    const { vault, dir } = await makeVault();
    const before = await snapshotFiles(dir);
    const run = await vault.dream({ llm, options: { minTouchAllowance: 1 } });
    expect(run.entry?.status).toBe("rejected");
    expect(await snapshotFiles(dir)).toEqual(before);
  });

  it("persists dreaming settings", async () => {
    const { vault } = await makeVault();
    expect(vault.dreamConfig()).toEqual({ enabled: true, cadenceHours: 24 });
    await vault.configureDreaming({ enabled: false, cadenceHours: 500 });
    expect(vault.dreamConfig()).toEqual({ enabled: false, cadenceHours: 168 });
  });
});
