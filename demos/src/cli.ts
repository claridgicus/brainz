#!/usr/bin/env bun
/**
 * `npm run demos:record [-- id …] [--all] [--jobs <n>] [--render-jobs <n>]
 * [--timeout <s>] [--headed] [--keep] [--keep-stack] [--no-build] [--real-time]`
 * — record demos (the stale ones; the ones named; every one with `--all`):
 * build the app from the working tree, bring up a fresh compose stack
 * (`stack.ts`), sign up and seed a demo account per demo (`tenant.ts`), take
 * each flow in a browser, render both cuts into the marketing site's
 * `static/demos/` in segments, stamp `demos/fingerprints.json`, and take the
 * stack down again. Run it through `mheavy`: every child (and the stack's
 * container) keeps to the CPU block it was given.
 *
 * `npm run demos:check [-- --rev <commit>]` — the gate: every demo's recorded
 * fingerprint must match the sources as the index holds them (or as
 * `<commit>` holds them), and its files must exist. Fast (one git listing),
 * needs no browser and no stack. CI runs it warn-only.
 *
 * `npm run demos:stack -- up|down|logs` — the stack by hand, to look around in.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism, setPriority } from "node:os";
import { FPS, compose, concatenate, frameCountOf } from "./compose.js";
import {
  fingerprint,
  gitBlobOid,
  parseIndexListing,
  parseTreeListing,
  staleness,
  type Blob,
  type Fingerprints,
} from "./fingerprint.js";
import { DEMOS, outputsOf, type Context, type Demo } from "./manifest.js";
import * as stack from "./stack.js";
import { Take, type TakeLog } from "./take.js";
import { client, demoTenant, type DemoTenant } from "./tenant.js";

const root = stack.root;
const site = join(root, "apps/marketing");
const fingerprintsFile = join(root, "demos/fingerprints.json");
const takesDir = join(root, "demos/.takes");

const say = (line: string) => console.log(line); // lint: allow-log(CLI output for a person)

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

/** The tree as the index holds it: what a commit would contain. */
const indexBlobs = (): ReadonlyArray<Blob> => parseIndexListing(git("ls-files", "-s"));

/**
 * The tree as the working copy holds it: what a recording is made from —
 * tracked files and untracked ones alike (a new source is a source), ignored
 * ones left out.
 */
const workingBlobs = async (): Promise<ReadonlyArray<Blob>> => {
  const listing = git("ls-files", "-z", "--cached", "--others", "--exclude-standard");
  const paths = [...new Set(listing.split("\0").filter((path) => path !== ""))];
  const blobs: Blob[] = [];
  for (const path of paths) {
    const file = join(root, path);
    if (!existsSync(file)) continue;
    blobs.push({ path, oid: gitBlobOid(await readFile(file)) });
  }
  return blobs;
};

/** The tree as `rev` holds it: what a push or a merge would land. */
const revBlobs = (rev: string): ReadonlyArray<Blob> => parseTreeListing(git("ls-tree", "-r", rev));

const readFingerprints = async (): Promise<Fingerprints> =>
  existsSync(fingerprintsFile) ? (JSON.parse(await readFile(fingerprintsFile, "utf8")) as Fingerprints) : {};

const writeFingerprints = async (fingerprints: Fingerprints) => {
  const sorted = Object.fromEntries(Object.entries(fingerprints).sort(([a], [b]) => (a < b ? -1 : 1)));
  await writeFile(fingerprintsFile, JSON.stringify(sorted, null, 2) + "\n");
};

const check = async (rev: string | undefined): Promise<number> => {
  const blobs = rev === undefined ? indexBlobs() : revBlobs(rev);
  const fingerprintsPath = "demos/fingerprints.json";
  const recorded =
    rev === undefined
      ? await readFingerprints()
      : blobs.some((blob) => blob.path === fingerprintsPath)
        ? (JSON.parse(git("show", `${rev}:${fingerprintsPath}`)) as Fingerprints)
        : {};
  const present = new Set(blobs.map((blob) => blob.path));
  const exists = (file: string) =>
    rev === undefined ? existsSync(join(site, file)) : present.has(`apps/marketing/${file}`);
  const stale: string[] = [];
  for (const demo of DEMOS) {
    const hash = fingerprint(demo.dependencies, blobs);
    const state = staleness(demo.id, hash, recorded, outputsOf(demo.id), exists);
    if (state.kind === "fresh") continue;
    const why =
      state.kind === "unrecorded"
        ? "never recorded"
        : state.kind === "changed"
          ? "its sources changed since it was recorded"
          : `${state.file} is missing`;
    stale.push(`  - ${demo.id}: ${why}`);
  }
  const unknown = Object.keys(recorded).filter((id) => !DEMOS.some((demo) => demo.id === id));
  if (unknown.length > 0) stale.push(`  - fingerprints.json names demos the manifest does not: ${unknown.join(", ")}`);
  if (stale.length === 0) {
    say(`demos gate: ok — ${DEMOS.length} clip(s) match their sources.`);
    return 0;
  }
  say("demos gate: stale clips —");
  for (const line of stale) say(line);
  say("  re-record the stale ones:  mheavy npm run demos:record");
  return 1;
};

interface RecordFlags {
  readonly headed: boolean;
  readonly keep: boolean;
  readonly keepStack: boolean;
  readonly build: boolean;
  readonly realTime: boolean;
  readonly all: boolean;
  readonly jobs: number | undefined;
  readonly renderJobs: number | undefined;
  readonly timeout: number | undefined;
}

/** Output frames per render segment: six seconds of clip, a few seconds of work. */
const SEGMENT_FRAMES = 360;

/**
 * Seeds, and takes, side by side, by default. The stack is one wrangler
 * process, so more at once only queues on it. Seeds and takes are separate
 * children with separate pools, so the next account seeds while a take
 * records and a queued seed never eats into a take's timeout.
 */
const TAKE_JOBS = 4;

/** How long any one child (a take, a render segment) may run before it is stopped, by default. */
const CHILD_TIMEOUT_S = 180;

/** How long a stopped child's group has to exit on SIGTERM before it is killed. */
const KILL_GRACE_MS = 5000;

/** x264 threads per segment: many segments share the machine, and fewer threads waste less on each other. */
const ENCODER_THREADS = 3;

/** At most this many runs of `limit` at a time, in the order they were asked for. */
const pool = (limit: number) => {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
};

/** Children still running, so an interrupted recorder can take them down with it. */
const running = new Set<ChildProcess>();

/** Stop a child and everything it started: SIGTERM first (Playwright closes its browser on it), SIGKILL if it lingers. */
const stop = (proc: ChildProcess): void => {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  const group = -proc.pid;
  try {
    process.kill(group, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(group, "SIGKILL");
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS).unref();
};

/** In the recorder: an interrupt stops every child before the recorder goes. */
const stopChildrenOnInterrupt = (): void => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      for (const proc of running) stop(proc);
      process.exit(130);
    });
  }
};

/**
 * Run this CLI again as a child. The recorder's own process never launches
 * a browser, so it can spawn and reap children freely (see `git` above):
 * every take and every render segment is a child of its own, which is what
 * lets them run side by side. Each child leads a process group of its own —
 * its browser, its ffmpeg — and the whole group is stopped when it outlives
 * `timeoutMs` or the recorder is interrupted; a child whose recorder dies
 * anyway notices and exits (`watchParent`).
 */
const child = async (
  args: ReadonlyArray<string>,
  options: { readonly quiet?: boolean; readonly yielding?: boolean; readonly timeoutMs: number },
): Promise<void> => {
  const command = [process.execPath, "--import", "tsx", new URL("./cli.ts", import.meta.url).pathname, ...args];
  // `DEMOS_CPUS` pins a recorder that was not started under `mheavy`/`taskset`.
  const pinned = process.env.DEMOS_CPUS === undefined ? command : ["taskset", "-c", process.env.DEMOS_CPUS, ...command];
  const proc = spawn(pinned[0]!, pinned.slice(1), {
    cwd: root,
    detached: true,
    // stdin is a pipe that closes when this process does: the child's sign it is on its own (`watchParent`).
    stdio: ["pipe", options.quiet === true ? "ignore" : "inherit", "inherit"],
  });
  running.add(proc);
  // A render yields the CPU to the takes still recording: their frames are real time, its are not.
  if (options.yielding === true && proc.pid !== undefined) {
    try {
      setPriority(proc.pid, 10);
    } catch {
      // only a courtesy
    }
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop(proc);
  }, options.timeoutMs);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("exit", (exit) => resolve(exit));
    });
    const what = args.slice(0, 2).join(" ");
    if (timedOut) throw new Error(`${what} timed out after ${Math.round(options.timeoutMs / 1000)}s and was stopped`);
    if (code !== 0) throw new Error(`${what} exited ${code ?? proc.signalCode}`);
  } finally {
    clearTimeout(timer);
    running.delete(proc);
    // Whatever the child left behind in its group goes with it.
    stop(proc);
  }
};

/**
 * In a child: exit when the recorder that started it is gone, so nothing
 * outlives a killed recording. The recorder holds the other end of the
 * child's stdin, and an exiting process's pipes close however it went.
 */
const watchParent = (): void => {
  process.stdin.on("end", () => process.exit(1));
  process.stdin.on("close", () => process.exit(1));
  process.stdin.resume();
};

/** The demos to record: the ones named, every one with `--all`, else the ones whose clips are stale. */
const choose = (ids: ReadonlyArray<string>, all: boolean, hashes: ReadonlyMap<string, string>, recorded: Fingerprints): ReadonlyArray<Demo> => {
  if (ids.length > 0) {
    return ids.map((id) => {
      const demo = DEMOS.find((d) => d.id === id);
      if (demo === undefined) throw new Error(`no demo "${id}"; known: ${DEMOS.map((d) => d.id).join(", ")}`);
      return demo;
    });
  }
  if (all) return DEMOS;
  return DEMOS.filter(
    (demo) => staleness(demo.id, hashes.get(demo.id)!, recorded, outputsOf(demo.id), (file) => existsSync(join(site, file))).kind !== "fresh",
  );
};

/**
 * `record`: the stale demos (or the ones named, or `--all`), each taken in a
 * child of its own — `--jobs` at a time — and each
 * cut rendered as segments by a pool of children as soon as its take is in,
 * then joined. Fingerprints are of the working tree as the recording began.
 */
const record = async (ids: ReadonlyArray<string>, flags: RecordFlags): Promise<number> => {
  const blobs = await workingBlobs();
  const hashes = new Map(DEMOS.map((demo) => [demo.id, fingerprint(demo.dependencies, blobs)]));
  const fingerprints = { ...(await readFingerprints()) };
  const chosen = choose(ids, flags.all, hashes, fingerprints);
  if (chosen.length === 0) {
    say("demos: every clip matches its sources — nothing to record (--all records them anyway).");
    return 0;
  }
  const personas = new Set(chosen.map((demo) => demo.persona.email));
  if (personas.size !== chosen.length) throw new Error("two demos share a persona email: give each its own in manifest.ts");
  const cpus = availableParallelism();
  if (process.env.DEMOS_CPUS === undefined && /^0[-,]|^0$/.test(stack.allowedCpus() ?? "0")) {
    say("demos: not pinned to a CPU block — run it as `mheavy npm run demos:record`, or set DEMOS_CPUS=8-15.");
  }
  if (flags.build) stack.build(say);
  await stack.up(say);
  try {
    return await recordOn(chosen, hashes, flags, cpus);
  } finally {
    if (flags.keepStack) say(`demos: the stack stays up at ${stack.origin()} (npm run demos:stack -- down)`);
    else stack.down();
  }
};

const recordOn = async (
  chosen: ReadonlyArray<Demo>,
  hashes: ReadonlyMap<string, string>,
  flags: RecordFlags,
  cpus: number,
): Promise<number> => {
  const fingerprints = { ...(await readFingerprints()) };
  await mkdir(join(site, "static/demos"), { recursive: true });
  const seeds = pool(flags.jobs ?? Math.min(chosen.length, TAKE_JOBS));
  const takes = pool(flags.jobs ?? Math.min(chosen.length, TAKE_JOBS));
  const renders = pool(flags.renderJobs ?? Math.max(2, Math.floor(cpus / 2)));
  const timeoutMs = (flags.timeout ?? CHILD_TIMEOUT_S) * 1000;
  const began = performance.now();
  const elapsed = () => `${((performance.now() - began) / 1000).toFixed(0)}s`;
  say(`demos: recording ${chosen.map((d) => d.id).join(", ")}`);

  // Renders wait until every account is seeded: an encoder on every core of
  // the block starves the stack beside it.
  let unseeded = chosen.length;
  let allSeeded: () => void = () => undefined;
  const seeding = new Promise<void>((resolve) => (allSeeded = resolve));
  const seeded = () => --unseeded === 0 && allSeeded();

  const one = async (demo: Demo): Promise<void> => {
    const dir = join(takesDir, demo.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await seeds(() => child(["seed", demo.id, dir], { timeoutMs })).finally(seeded);
    await takes(() =>
      child(["take", demo.id, dir, ...(flags.headed ? ["--headed"] : []), ...(flags.realTime ? ["--real-time"] : [])], { timeoutMs }),
    );
    const log = JSON.parse(await readFile(join(dir, "take.json"), "utf8")) as TakeLog;
    const frames = frameCountOf(log);
    say(`  ${demo.id}: take in at ${elapsed()} — ${(frames / FPS).toFixed(1)}s of clip`);
    await seeding;
    await Promise.all(
      (["backdrop", "bleed"] as const).map(async (variant) => {
        const name = `${demo.id}${variant === "bleed" ? "-bleed" : ""}`;
        const poster = join(site, `static/demos/${name}.webp`);
        const segments: Array<{ file: string; frames: number }> = [];
        const work: Promise<void>[] = [];
        for (let from = 0; from < frames; from += SEGMENT_FRAMES) {
          const segment = join(dir, `${variant}-${String(segments.length).padStart(3, "0")}.mp4`);
          const to = Math.min(frames, from + SEGMENT_FRAMES);
          segments.push({ file: segment, frames: to - from });
          work.push(
            renders(() =>
              child(["render", dir, variant, segment, poster, "--from", String(from), "--to", String(to), "--threads", String(ENCODER_THREADS)], { quiet: true, yielding: true, timeoutMs }),
            ),
          );
        }
        await Promise.all(work);
        concatenate(segments, join(site, `static/demos/${name}.mp4`), join(dir, `${variant}.txt`));
      }),
    );
    fingerprints[demo.id] = { hash: hashes.get(demo.id)!, recordedAt: new Date().toISOString(), seconds: Math.round(frames / FPS) };
    await writeFingerprints(fingerprints);
    if (!flags.keep) await rm(dir, { recursive: true, force: true });
    say(`✓ ${demo.id} at ${elapsed()}`);
  };

  const outcomes = await Promise.allSettled(chosen.map(one));
  const failed = outcomes.flatMap((outcome, i) =>
    outcome.status === "rejected" ? [`  - ${chosen[i]!.id}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`] : [],
  );
  if (failed.length > 0) {
    say(`demos: ${failed.length} of ${chosen.length} failed in ${elapsed()} —`);
    for (const line of failed) say(line);
    return 1;
  }
  say(`recorded ${chosen.length} clip(s) in ${elapsed()}; stage apps/marketing/static/demos and demos/fingerprints.json.`);
  return 0;
};

/**
 * `seed <id> <dir>`: one demo's account, in its own process — signed up
 * fresh and seeded with the sample product — left in `<dir>/tenant.json`
 * for the take.
 */
const seedOne = async (args: ReadonlyArray<string>): Promise<number> => {
  const [id, dir] = args;
  const demo = DEMOS.find((d) => d.id === id);
  if (demo === undefined || dir === undefined) throw new Error("seed <id> <dir>");
  const tenant = await demoTenant(stack.origin(), demo.persona, demo.extraVaults);
  await writeFile(join(dir, "tenant.json"), JSON.stringify(tenant));
  say(`  ${demo.id}: signed up ${demo.persona.email} with ${tenant.vaults.length} vault(s)`);
  return 0;
};

/**
 * `take <id> <dir>`: one demo's take, in its own process — the flow driven
 * in a browser as the account `seed` left in `<dir>`, the frames and
 * `take.json` left beside it for the renders.
 */
const takeOne = async (args: ReadonlyArray<string>, flags: { headed: boolean; realTime: boolean }): Promise<number> => {
  const [id, dir] = args;
  const demo = DEMOS.find((d) => d.id === id);
  if (demo === undefined || dir === undefined) throw new Error("take <id> <dir>");
  const tag = (line: string) => say(`  ${demo.id}: ${line}`);
  const origin = stack.origin();
  const tenant = JSON.parse(await readFile(join(dir, "tenant.json"), "utf8")) as DemoTenant;
  const context: Context = { origin, tenant, api: client(origin, tenant.cookies), scratch: dir };
  const take = await Take.open({ dir, origin, cookies: tenant.cookies, headless: !flags.headed, realTime: flags.realTime });
  const began = performance.now();
  try {
    await demo.run(take, context);
  } catch (error) {
    await take.page.screenshot({ path: join(dir, "failed.png") }).catch(() => undefined);
    await take.end().catch(() => undefined);
    throw new Error(`${demo.id} failed: ${error instanceof Error ? error.message : String(error)} (see ${dir}/failed.png)`);
  }
  const log = await take.end();
  tag(`${log.frames.length} frames, ${(log.duration / 1000).toFixed(1)}s of take recorded in ${((performance.now() - began) / 1000).toFixed(1)}s (${(take.skipped / 1000).toFixed(1)}s of holds skipped)`);
  return 0;
};

/** `stack up|down|logs`: the demo stack by hand. */
const stackCommand = async (args: ReadonlyArray<string>): Promise<number> => {
  const [action] = args;
  if (action === "up") {
    await stack.up(say);
    say(`demos: the stack is up at ${stack.origin()}`);
  } else if (action === "down") {
    stack.down();
  } else if (action === "logs") {
    say(stack.logs());
  } else {
    throw new Error("stack up|down|logs");
  }
  return 0;
};

/** `render <dir> <variant> <output> [poster] [--from <frame>] [--to <frame>] [--threads <n>]`: one cut, or one segment of it, in its own process. */
const render = async (args: ReadonlyArray<string>): Promise<number> => {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : Number(args[at + 1]);
  };
  const [dir, variant, output, poster] = args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (dir === undefined || (variant !== "backdrop" && variant !== "bleed") || output === undefined) {
    throw new Error("render <dir> backdrop|bleed <output.mp4> [poster.webp] [--from <frame>] [--to <frame>]");
  }
  const from = option("--from");
  const to = option("--to");
  const threads = option("--threads");
  const { seconds } = await compose({
    dir,
    variant,
    output,
    ...(poster === undefined ? {} : { poster }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(threads === undefined ? {} : { threads }),
  });
  say(String(seconds));
  return 0;
};

const numberAfter = (args: ReadonlyArray<string>, name: string): number | undefined => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} needs a whole number of at least 1`);
  return value;
};

const [command = "check", ...rest] = process.argv.slice(2);
const valued = new Set(["--rev", "--jobs", "--render-jobs", "--timeout"]);
const revAt = rest.indexOf("--rev");
const rev = revAt < 0 ? undefined : rest[revAt + 1];
if (revAt >= 0 && (rev === undefined || rev.startsWith("--"))) {
  say("demos: --rev needs a commit");
  process.exit(2);
}
const ids = rest.filter((arg, i) => !arg.startsWith("--") && !valued.has(rest[i - 1] ?? ""));
try {
  const flags: RecordFlags = {
    headed: rest.includes("--headed"),
    keep: rest.includes("--keep"),
    keepStack: rest.includes("--keep-stack"),
    build: !rest.includes("--no-build"),
    realTime: rest.includes("--real-time"),
    all: rest.includes("--all"),
    jobs: numberAfter(rest, "--jobs"),
    renderJobs: numberAfter(rest, "--render-jobs"),
    timeout: numberAfter(rest, "--timeout"),
  };
  if (command === "seed" || command === "take" || command === "render") watchParent();
  if (command === "record") stopChildrenOnInterrupt();
  process.exit(
    command === "record"
      ? await record(ids, flags)
      : command === "seed"
        ? await seedOne(rest)
        : command === "take"
        ? await takeOne(rest, flags)
        : command === "render"
          ? await render(rest)
          : await check(rev),
  );
} catch (error) {
  say(`demos: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
