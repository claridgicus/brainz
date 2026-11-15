/**
 * The local task history log is written by several processes (the MCP server,
 * the CLI, the web server) with no lock, so it must stay strictly
 * append-only: a writer that read the log and then replaced it would drop
 * whatever another process appended in between. This replays that exact
 * interleaving: while one Vault persists a legacy task's rebuilt history,
 * "another process" appends an event for a different task right after every
 * read the writer makes of the log, so whatever it writes next comes after
 * an append it never saw.
 */
import matter from "gray-matter";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Vault } from "../src/index.js";

/** While set, runs after every read of the history log (between a writer's read and its write). */
const hook = vi.hoisted(() => ({ afterRead: null as null | (() => void) }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const out = actual.readFileSync(...args);
    if (hook.afterRead && String(args[0]).endsWith("task-events.jsonl")) hook.afterRead();
    return out;
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  hook.afterRead = null;
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("task history log under concurrent writers", () => {
  it("persisting rebuilt history never drops an event another process appended meanwhile", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "brainz-history-race-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(path.join(dir, "brainz.config.json"), JSON.stringify({ name: "t", embedding: { provider: "none" } }));
    await mkdir(path.join(dir, "concepts"), { recursive: true });
    // A task from before the log: done, its claim older than its creation write.
    await writeFile(
      path.join(dir, "concepts", "a.md"),
      matter.stringify("", {
        id: "a",
        title: "A",
        type: "task",
        task_status: "done",
        taken_by: "w",
        createdAt: "2026-11-01T12:00:00.000Z",
        taken_at: "2026-10-30T12:00:00.000Z",
        done_at: "2026-11-01T12:00:00.000Z",
      }),
    );
    const vault = await Vault.open(dir);
    cleanups.push(async () => vault.close());
    await vault.upsertConcept({ id: "b", title: "B", body: "", type: "task", taskStatus: "open" });

    const logPath = path.join(dir, "history", "task-events.jsonl");
    const { appendFileSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const theirs: { at: string; task: string; kind: string; by: string }[] = [];
    hook.afterRead = () => {
      const e = { at: new Date().toISOString(), task: "b", kind: "taken", by: `cli-${theirs.length}` };
      theirs.push(e);
      appendFileSync(logPath, `${JSON.stringify(e)}\n`);
    };

    // This edit reads the log, persists a's rebuilt history, then appends its own event.
    await vault.upsertConcept({ id: "a", title: "A", body: "", estimate: 3 });
    hook.afterRead = null;
    expect(theirs.length).toBeGreaterThan(0); // the interleaving happened

    const events = vault.taskEvents();
    for (const e of theirs) expect(events).toContainEqual(e);
    expect(events.filter((e) => e.task === "a").map((e) => e.kind)).toEqual([
      "created",
      "taken",
      "done",
      "estimated",
    ]);
    // Strictly appended: the file still starts with what was there before.
    const raw = await readFile(logPath, "utf8");
    expect(raw.split("\n")[0]).toContain('"task":"b","kind":"created"');
    expect(raw.trim().split("\n")).toHaveLength(events.length);
  });
});
