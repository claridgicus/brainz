#!/usr/bin/env node
/**
 * brainz-orch: the local half of the brainz-orchestrate Claude Code plugin (SPEC.md "Orchestration").
 * Zero dependencies, Node >= 20. Worktrees, tmux worker windows, the heavy-step semaphore, landing.
 * Brainz itself (tasks, config concept) is reached by the orchestrator through MCP, never from here.
 *
 *   brainz-orch config set <file|->        cache the orchestrate-config concept (markdown or JSON)
 *   brainz-orch config show
 *   brainz-orch job start <task> [--branch b] [--base ref] [--no-launch]
 *   brainz-orch job list
 *   brainz-orch watch [--once] [--interval s] [--idle s]
 *   brainz-orch peek <branch> [--lines n]
 *   brainz-orch send <branch> [--keys] <text…>
 *   brainz-orch heavy -- <cmd…>
 *   brainz-orch land <branch> [--mode push|pr]
 *   brainz-orch done <branch> [--force]
 *   brainz-orch brief <task> [--branch b]
 *
 * Global: --json for machine output. Exit 0 ok, 1 reported failure, 2 bad usage.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const BRIEF_TEMPLATE = path.join(PLUGIN_ROOT, "skills", "orchestrate", "worker-brief.md");

export const DEFAULTS = Object.freeze({
  setup: [],
  gates: [],
  concurrency: 3,
  heavySlots: 2,
  heavyCpus: null,
  landing: "pr",
  mainBranch: null, // null ⇒ origin's default branch, else "main"
  leaseMinutes: 60,
  idleSeconds: 120,
  worker: { command: "claude", args: [] },
  workerExtra: "",
});

class OrchError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const usage = (msg) => new OrchError(msg, 2);

// ---- small helpers ---------------------------------------------------------

/** Single-quote for sh. */
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function run(cmd, args, { cwd, allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
  if (r.error) {
    if (allowFail) return { ok: false, out: "", err: String(r.error.message) };
    throw new OrchError(`${cmd}: ${r.error.message}`);
  }
  const res = { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
  if (!res.ok && !allowFail) {
    throw new OrchError(`${cmd} ${args.join(" ")} failed: ${res.err || res.out || `exit ${r.status}`}`);
  }
  return res;
}
const git = (args, opts) => run("git", args, opts);

/** Run a shell command with its output on our stderr (stdout stays clean for --json). */
function sh(command, cwd) {
  const r = spawnSync("sh", ["-c", command], { cwd, stdio: ["ignore", 2, 2] });
  return r.status ?? 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasBin = (bin) => spawnSync("sh", ["-c", `command -v ${q(bin)}`], { stdio: "ignore" }).status === 0;
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
};

// ---- repo + state ----------------------------------------------------------

/** The main checkout and the shared state dir, from any worktree of the repo. */
export function repoInfo(cwd = process.cwd()) {
  const r = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, allowFail: true });
  if (!r.ok) throw new OrchError("not inside a git repository");
  const commonDir = r.out;
  const repo = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  return { repo, commonDir, stateDir: path.join(commonDir, "brainz-orchestrate") };
}

// ---- config ----------------------------------------------------------------

const CONFIG_TYPES = {
  setup: "string[]",
  gates: "string[]",
  concurrency: "posint",
  heavySlots: "posint",
  heavyCpus: "string|null",
  landing: "landing",
  mainBranch: "string|null",
  leaseMinutes: "posint",
  idleSeconds: "posint",
  worker: "worker",
  workerExtra: "string",
};

function checkType(key, v, type) {
  const isStrArr = (a) => Array.isArray(a) && a.every((s) => typeof s === "string");
  const ok = {
    "string[]": () => isStrArr(v),
    posint: () => Number.isInteger(v) && v > 0,
    "string|null": () => v === null || typeof v === "string",
    string: () => typeof v === "string",
    landing: () => v === "push" || v === "pr",
    worker: () =>
      v !== null &&
      typeof v === "object" &&
      typeof v.command === "string" &&
      v.command.length > 0 &&
      (v.args === undefined || isStrArr(v.args)),
  }[type]();
  if (!ok) throw new OrchError(`config: "${key}" must be ${type === "landing" ? '"push" or "pr"' : type}`);
}

/**
 * Parse the orchestrate-config concept: either raw JSON, or markdown whose first ```json fence is
 * the config and whose remaining prose becomes `workerExtra` (unless the JSON sets it).
 */
export function parseConfigSource(text) {
  let raw;
  let prose = "";
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    raw = trimmed;
  } else {
    const body = trimmed.replace(/^---\n[\s\S]*?\n---\n?/, "");
    const m = body.match(/```json[^\n]*\n([\s\S]*?)```/);
    raw = m ? m[1] : "{}";
    prose = (m ? body.replace(m[0], "") : body).trim();
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new OrchError(`config: invalid JSON (${e.message})`);
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new OrchError("config: expected a JSON object");
  for (const [k, v] of Object.entries(cfg)) {
    if (!(k in CONFIG_TYPES)) throw new OrchError(`config: unknown key "${k}"`);
    checkType(k, v, CONFIG_TYPES[k]);
  }
  if (cfg.workerExtra === undefined && prose) cfg.workerExtra = prose;
  return cfg;
}

export function loadConfig(info) {
  const saved = info ? readJson(path.join(info.stateDir, "config.json"), {}) : {};
  const cfg = { ...DEFAULTS, ...saved, worker: { ...DEFAULTS.worker, ...(saved.worker ?? {}) } };
  cfg.worker.args = cfg.worker.args ?? [];
  if (process.env.BRAINZ_ORCH_HEAVY_SLOTS) cfg.heavySlots = Number(process.env.BRAINZ_ORCH_HEAVY_SLOTS) || cfg.heavySlots;
  if (process.env.BRAINZ_ORCH_HEAVY_CPUS) cfg.heavyCpus = process.env.BRAINZ_ORCH_HEAVY_CPUS;
  if (info && !cfg.mainBranch) {
    const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: info.repo, allowFail: true });
    cfg.mainBranch = r.ok && r.out.startsWith("origin/") ? r.out.slice("origin/".length) : "main";
  }
  return cfg;
}

// ---- jobs ------------------------------------------------------------------

const jobsFile = (info) => path.join(info.stateDir, "jobs.json");
const loadJobs = (info) => readJson(jobsFile(info), { jobs: {} }).jobs ?? {};
const saveJobs = (info, jobs) => writeJson(jobsFile(info), { jobs });

function getJob(info, branch) {
  const job = loadJobs(info)[branch];
  if (!job) throw new OrchError(`no job for branch "${branch}" (see \`job list\`)`);
  return job;
}

export function defaultBranch(task) {
  return task.slice(0, 40).replace(/-+$/, "");
}

export function renderBrief({ task, branch, worktree, base, repo }, cfg) {
  const template = fs.readFileSync(BRIEF_TEMPLATE, "utf8");
  const extra = cfg.workerExtra?.trim() ? `\nRepo rules (from the orchestrate-config concept):\n\n${cfg.workerExtra.trim()}\n` : "";
  const vars = {
    TASK: task,
    BRANCH: branch,
    PATH: worktree,
    BASE: base,
    REPO: repo,
    ORCH: `node ${q(SCRIPT)}`,
    EXTRA: extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function workerCommand(job, cfg) {
  const argv = [cfg.worker.command, ...cfg.worker.args].map(q).join(" ");
  return `cd ${q(job.path)} && ${argv} "$(cat ${q(job.brief)})"`;
}

function worktreeForBranch(info, branch) {
  const out = git(["worktree", "list", "--porcelain"], { cwd: info.repo }).out;
  for (const block of out.split("\n\n")) {
    const wt = block.match(/^worktree (.*)$/m)?.[1];
    const br = block.match(/^branch refs\/heads\/(.*)$/m)?.[1];
    if (wt && br === branch) return wt;
  }
  return null;
}

// ---- tmux ------------------------------------------------------------------

const tmuxBin = () => process.env.BRAINZ_ORCH_TMUX || "tmux";
const tmuxAvailable = () => (process.env.BRAINZ_ORCH_TMUX ? true : hasBin("tmux"));
const tmux = (args, opts = {}) => run(tmuxBin(), args, opts);

function paneAlive(pane) {
  if (!pane) return false;
  const r = tmux(["display-message", "-p", "-t", pane, "#{pane_id}"], { allowFail: true });
  return r.ok && r.out === pane;
}

/** Open a tmux window for the job (current session inside tmux, else a detached per-repo session). */
function launchTmux(info, job, command) {
  let pane;
  let session = null;
  const window = ["-n", job.branch, "-c", job.path, "-P", "-F", "#{pane_id}"];
  if (process.env.TMUX) {
    pane = tmux(["new-window", "-d", ...window]).out;
  } else {
    session = `brainz-${path.basename(info.repo)}`.replace(/[^A-Za-z0-9_-]/g, "-");
    const exists = tmux(["has-session", "-t", session], { allowFail: true }).ok;
    pane = exists
      ? tmux(["new-window", "-d", "-t", `${session}:`, ...window]).out
      : tmux(["new-session", "-d", "-s", session, ...window]).out;
  }
  tmux(["send-keys", "-t", pane, "-l", command]);
  tmux(["send-keys", "-t", pane, "Enter"]);
  return { mode: "tmux", pane, session, attach: session ? `tmux attach -t ${session}` : null };
}

function capture(pane, lines = 60) {
  const r = tmux(["capture-pane", "-p", "-J", "-t", pane, "-S", `-${lines}`], { allowFail: true });
  return r.ok ? r.out : null;
}

/** The worker's final contract line, if its pane ends with one (the echoed brief doesn't count). */
export function finalMarker(text) {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[\s⏺●•>]+/, "").trimEnd())
    .filter((l) => l.trim() !== "");
  for (const line of lines.slice(-15).reverse()) {
    if (line.includes("`") || line.includes("<why>")) continue;
    const m = line.match(/^JOB (READY|STUCK) (\S+?)(?::\s*(.*))?$/);
    if (m) return { state: m[1] === "READY" ? "ready" : "stuck", task: m[2], reason: m[3] ?? null };
  }
  return null;
}

// ---- commands --------------------------------------------------------------

function cmdConfig(args, out) {
  const [sub, src] = args;
  if (sub === "set") {
    if (!src) throw usage("usage: config set <file|->");
    const info = repoInfo();
    const text = src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8");
    const cfg = parseConfigSource(text);
    writeJson(path.join(info.stateDir, "config.json"), cfg);
    return out({ saved: true, config: loadConfig(info) }, () => "config saved");
  }
  if (sub === "show") {
    const cfg = loadConfig(repoInfo());
    return out(cfg, () => JSON.stringify(cfg, null, 2));
  }
  throw usage("usage: config set <file|-> | config show");
}

async function cmdJob(args, flags, out) {
  const [sub, task] = args;
  const info = repoInfo();
  const cfg = loadConfig(info);
  if (sub === "start") {
    if (!task) throw usage("usage: job start <task-id> [--branch b] [--base ref] [--no-launch]");
    const branch = flags.branch ?? defaultBranch(task);
    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw usage(`bad branch name "${branch}"`);
    const jobs = loadJobs(info);
    const open = Object.keys(jobs).filter((b) => b !== branch).length;
    if (open >= cfg.concurrency) {
      throw new OrchError(`concurrency ${cfg.concurrency} reached (${open} open jobs); land or \`done\` one first`);
    }
    git(["fetch", "-q", "origin"], { cwd: info.repo, allowFail: true });
    const base = flags.base ?? `origin/${cfg.mainBranch}`;
    let worktree = worktreeForBranch(info, branch);
    let created = false;
    if (!worktree) {
      worktree = path.join(path.dirname(info.repo), `${path.basename(info.repo)}-${branch.replace(/\//g, "-")}`);
      const exists = git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: info.repo, allowFail: true }).ok;
      git(exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, base], {
        cwd: info.repo,
      });
      created = true;
    }
    if (created) {
      for (const step of cfg.setup) {
        if (sh(step, worktree) !== 0) throw new OrchError(`setup step failed in ${worktree}: ${step}`);
      }
    }
    const brief = path.join(info.stateDir, "briefs", `${branch.replace(/\//g, "-")}.md`);
    fs.mkdirSync(path.dirname(brief), { recursive: true });
    fs.writeFileSync(brief, renderBrief({ task, branch, worktree, base, repo: info.repo }, cfg));
    const job = { task, branch, path: worktree, base, brief, pane: jobs[branch]?.pane ?? null, startedAt: new Date().toISOString() };
    const command = workerCommand(job, cfg);
    let launch = { mode: "manual", command };
    if (!flags["no-launch"] && tmuxAvailable() && !paneAlive(job.pane)) {
      launch = { ...launchTmux(info, job, command), command };
      job.pane = launch.pane;
    } else if (paneAlive(job.pane)) {
      launch = { mode: "tmux", pane: job.pane, reused: true, command };
    }
    jobs[branch] = job;
    saveJobs(info, jobs);
    const res = { task, branch, path: worktree, base, brief, created, launch };
    return out(res, () =>
      [
        `job ${branch} → ${worktree}${created ? "" : " (reused)"}`,
        launch.mode === "tmux"
          ? `worker running in tmux pane ${launch.pane}${launch.attach ? ` (${launch.attach})` : ""}`
          : `start the worker yourself:\n  ${command}`,
      ].join("\n"),
    );
  }
  if (sub === "list") {
    const now = Date.now();
    const list = Object.values(loadJobs(info)).map((job) => {
      const exists = fs.existsSync(job.path);
      let ahead = null;
      let dirty = null;
      let last = Date.parse(job.startedAt) || 0;
      if (exists) {
        const c = git(["rev-list", "--count", `${job.base}..HEAD`], { cwd: job.path, allowFail: true });
        ahead = c.ok ? Number(c.out) : null;
        const st = git(["status", "--porcelain", "-z"], { cwd: job.path, allowFail: true }).out;
        const files = st.split("\0").filter(Boolean).map((e) => e.slice(3));
        dirty = files.length > 0;
        const t = git(["log", "-1", "--format=%ct"], { cwd: job.path, allowFail: true });
        if (t.ok && t.out) last = Math.max(last, Number(t.out) * 1000);
        for (const f of files) {
          try {
            last = Math.max(last, fs.statSync(path.join(job.path, f)).mtimeMs);
          } catch {
            // deleted file
          }
        }
      }
      const alive = job.pane && tmuxAvailable() ? paneAlive(job.pane) : null;
      return {
        ...job,
        exists,
        ahead,
        dirty,
        paneAlive: alive,
        lastActivity: new Date(last).toISOString(),
        stale: now - last > cfg.leaseMinutes * 60_000,
      };
    });
    return out(list, () =>
      list.length === 0
        ? "no open jobs"
        : list
            .map(
              (j) =>
                `${j.branch}  task=${j.task}  ahead=${j.ahead ?? "?"}${j.dirty ? " dirty" : ""}` +
                `${j.pane ? `  pane=${j.pane}${j.paneAlive === false ? "(gone)" : ""}` : "  manual"}` +
                `${j.stale ? "  STALE" : ""}  last=${j.lastActivity}`,
            )
            .join("\n"),
    );
  }
  throw usage("usage: job start <task-id> … | job list");
}

/**
 * Block until a tmux-launched worker needs the orchestrator: it printed JOB READY/STUCK, its pane went
 * quiet for idleSeconds (usually a question or permission prompt), or its pane is gone. Each pane
 * state is reported once (remembered in watch.json), so re-running after handling a wake-up is safe.
 */
async function cmdWatch(flags, out) {
  const info = repoInfo();
  const cfg = loadConfig(info);
  const idleMs = (Number(flags.idle) || cfg.idleSeconds) * 1000;
  const intervalMs = (Number(flags.interval) || 15) * 1000;
  const seenFile = path.join(info.stateDir, "watch.json");
  for (;;) {
    const seen = readJson(seenFile, {});
    const events = [];
    const now = Date.now();
    for (const job of Object.values(loadJobs(info))) {
      if (!job.pane) continue;
      const prev = seen[job.branch] ?? {};
      const text = paneAlive(job.pane) ? capture(job.pane) : null;
      if (text === null) {
        if (prev.reported !== "gone") events.push({ branch: job.branch, task: job.task, pane: job.pane, state: "gone" });
        seen[job.branch] = { hash: null, since: now, reported: "gone" };
        continue;
      }
      const hash = createHash("sha1").update(text).digest("hex");
      const since = hash === prev.hash ? prev.since : now;
      const cur = { hash, since, reported: hash === prev.hash ? prev.reported : null };
      // A marker counts once the pane has settled for one interval (not while text still streams).
      const marker = finalMarker(text);
      let state = null;
      if (marker && hash === prev.hash) state = marker.state;
      else if (!marker && now - since >= idleMs) state = "idle";
      if (state && cur.reported !== state) {
        events.push({ branch: job.branch, task: job.task, pane: job.pane, state, ...(marker?.reason ? { reason: marker.reason } : {}) });
        cur.reported = state;
      }
      seen[job.branch] = cur;
    }
    writeJson(seenFile, seen);
    if (events.length > 0 || flags.once) {
      return out(events, () => events.map((e) => `${e.branch} ${e.state} ${e.task} ${e.pane}${e.reason ? `: ${e.reason}` : ""}`).join("\n"));
    }
    await sleep(intervalMs);
  }
}

function cmdPeek(args, flags, out) {
  const [branch] = args;
  if (!branch) throw usage("usage: peek <branch> [--lines n]");
  const job = getJob(repoInfo(), branch);
  if (!job.pane || !paneAlive(job.pane)) throw new OrchError(`job ${branch} has no live tmux pane`);
  const text = capture(job.pane, Number(flags.lines) || 120) ?? "";
  return out({ branch, pane: job.pane, text }, () => text);
}

function cmdSend(args, flags, out) {
  const [branch, ...rest] = args;
  if (!branch || rest.length === 0) throw usage("usage: send <branch> [--keys] <text…>");
  const info = repoInfo();
  const job = getJob(info, branch);
  if (!job.pane || !paneAlive(job.pane)) throw new OrchError(`job ${branch} has no live tmux pane`);
  if (flags.keys) {
    tmux(["send-keys", "-t", job.pane, ...rest]);
  } else {
    tmux(["send-keys", "-t", job.pane, "-l", rest.join(" ")]);
    tmux(["send-keys", "-t", job.pane, "Enter"]);
  }
  // The worker is busy again: let `watch` report its next stop even if it matches the last one.
  const seenFile = path.join(info.stateDir, "watch.json");
  const seen = readJson(seenFile, {});
  delete seen[branch];
  writeJson(seenFile, seen);
  return out({ sent: true, branch, pane: job.pane }, () => `sent to ${job.pane}`);
}

function heavyDir() {
  return process.env.BRAINZ_ORCH_HEAVY_DIR || path.join(os.homedir(), ".cache", "brainz-orchestrate", "heavy");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Take one of `slots` lock dirs (mkdir is atomic everywhere); a dead holder's slot is reclaimed. */
export function tryAcquireSlot(dir, slots) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < slots; i++) {
    const slot = path.join(dir, `slot${i}`);
    try {
      fs.mkdirSync(slot);
      fs.writeFileSync(path.join(slot, "pid"), String(process.pid));
      return slot;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let pid = NaN;
      try {
        pid = Number(fs.readFileSync(path.join(slot, "pid"), "utf8"));
      } catch {
        // holder is between mkdir and writing its pid; only reclaim if that's been going on for a while
        try {
          if (Date.now() - fs.statSync(slot).mtimeMs < 30_000) continue;
        } catch {
          continue;
        }
      }
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
      fs.rmSync(slot, { recursive: true, force: true });
      i--; // retry this slot
    }
  }
  return null;
}

async function cmdHeavy(argv) {
  const cmd = argv[0] === "--" ? argv.slice(1) : argv;
  if (cmd.length === 0) throw usage("usage: heavy -- <cmd…>");
  let info = null;
  try {
    info = repoInfo();
  } catch {
    // outside a repo: defaults
  }
  const cfg = loadConfig(info);
  const dir = heavyDir();
  let slot;
  let waited = false;
  while (!(slot = tryAcquireSlot(dir, cfg.heavySlots))) {
    if (!waited) process.stderr.write(`brainz-orch heavy: waiting for one of ${cfg.heavySlots} slots…\n`);
    waited = true;
    await sleep(2000);
  }
  const release = () => fs.rmSync(slot, { recursive: true, force: true });
  const pinned = cfg.heavyCpus && hasBin("taskset") ? ["taskset", "-c", cfg.heavyCpus, ...cmd] : cmd;
  const child = spawn(pinned[0], pinned.slice(1), { stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  const code = await new Promise((resolve) => {
    child.on("error", (e) => {
      process.stderr.write(`brainz-orch heavy: ${e.message}\n`);
      resolve(127);
    });
    child.on("exit", (c, s) => resolve(c ?? (s ? 1 : 0)));
  });
  release();
  return code;
}

function cmdLand(args, flags, out) {
  const [branch] = args;
  if (!branch) throw usage("usage: land <branch> [--mode push|pr]");
  const info = repoInfo();
  const cfg = loadConfig(info);
  const mode = flags.mode ?? cfg.landing;
  if (mode !== "push" && mode !== "pr") throw usage(`--mode must be push or pr`);
  const wt = loadJobs(info)[branch]?.path ?? worktreeForBranch(info, branch);
  if (!wt) throw new OrchError(`no worktree for branch "${branch}"`);
  const main = cfg.mainBranch;
  if (git(["status", "--porcelain"], { cwd: wt }).out) throw new OrchError(`${wt} has uncommitted changes; not landing`);
  git(["fetch", "-q", "origin"], { cwd: wt });
  const rebase = git(["rebase", "-q", `origin/${main}`], { cwd: wt, allowFail: true });
  if (!rebase.ok) {
    git(["rebase", "--abort"], { cwd: wt, allowFail: true });
    throw new OrchError(`rebase onto origin/${main} conflicted (aborted, nothing pushed): ${rebase.err}`);
  }
  for (const gate of cfg.gates) {
    const r = spawnSync(process.execPath, [SCRIPT, "heavy", "--", "sh", "-c", gate], { cwd: wt, stdio: ["ignore", 2, 2] });
    if (r.status !== 0) throw new OrchError(`gate failed: ${gate} (nothing pushed)`);
  }
  git(["fetch", "-q", "origin"], { cwd: wt });
  if (!git(["merge-base", "--is-ancestor", `origin/${main}`, "HEAD"], { cwd: wt, allowFail: true }).ok) {
    throw new OrchError(`origin/${main} moved during the gates; run land again`);
  }
  const commit = git(["rev-parse", "HEAD"], { cwd: wt }).out;
  if (mode === "push") {
    git(["push", "-q", "origin", `HEAD:refs/heads/${main}`], { cwd: wt });
    return out({ landed: true, mode, branch, commit }, () => `pushed ${commit.slice(0, 7)} to origin/${main}`);
  }
  git(["push", "-q", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`], { cwd: wt });
  let url = null;
  if (hasBin("gh")) {
    const existing = run("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], { cwd: wt, allowFail: true });
    url = existing.ok && existing.out ? existing.out : run("gh", ["pr", "create", "--fill", "--base", main, "--head", branch], { cwd: wt }).out.split("\n").pop();
  }
  return out({ landed: true, mode, branch, commit, pr: url }, () =>
    url ? `PR: ${url}` : `pushed ${branch}; gh not found, open the PR yourself`,
  );
}

function cmdDone(args, flags, out) {
  const [branch] = args;
  if (!branch) throw usage("usage: done <branch> [--force]");
  const info = repoInfo();
  const cfg = loadConfig(info);
  const jobs = loadJobs(info);
  const job = jobs[branch];
  const wt = job?.path ?? worktreeForBranch(info, branch);
  if (!flags.force && wt && fs.existsSync(wt)) {
    git(["fetch", "-q", "origin"], { cwd: wt, allowFail: true });
    const onMain = git(["merge-base", "--is-ancestor", "HEAD", `origin/${cfg.mainBranch}`], { cwd: wt, allowFail: true }).ok;
    const remote = git(["rev-parse", "-q", "--verify", `refs/remotes/origin/${branch}`], { cwd: wt, allowFail: true });
    const pushed = remote.ok && remote.out === git(["rev-parse", "HEAD"], { cwd: wt }).out;
    const clean = !git(["status", "--porcelain"], { cwd: wt }).out;
    if (!clean || !(onMain || pushed)) {
      throw new OrchError(`${branch} is not landed (not on origin/${cfg.mainBranch} or pushed, or dirty); use --force to discard`);
    }
  }
  if (job?.pane && tmuxAvailable() && paneAlive(job.pane)) tmux(["kill-pane", "-t", job.pane], { allowFail: true });
  if (wt && fs.existsSync(wt)) git(["worktree", "remove", ...(flags.force ? ["--force"] : []), wt], { cwd: info.repo });
  git(["worktree", "prune"], { cwd: info.repo, allowFail: true });
  git(["branch", "-D", branch], { cwd: info.repo, allowFail: true });
  delete jobs[branch];
  saveJobs(info, jobs);
  const seenFile = path.join(info.stateDir, "watch.json");
  const seen = readJson(seenFile, {});
  delete seen[branch];
  writeJson(seenFile, seen);
  if (job?.brief) fs.rmSync(job.brief, { force: true });
  return out({ removed: true, branch, path: wt }, () => `removed ${branch}${wt ? ` (${wt})` : ""}`);
}

function cmdBrief(args, flags, out) {
  const [task] = args;
  if (!task) throw usage("usage: brief <task-id> [--branch b]");
  const info = repoInfo();
  const cfg = loadConfig(info);
  const branch = flags.branch ?? defaultBranch(task);
  const worktree = path.join(path.dirname(info.repo), `${path.basename(info.repo)}-${branch.replace(/\//g, "-")}`);
  const text = renderBrief({ task, branch, worktree, base: flags.base ?? `origin/${cfg.mainBranch}`, repo: info.repo }, cfg);
  return out({ brief: text }, () => text);
}

// ---- entry -----------------------------------------------------------------

const BOOL_FLAGS = new Set(["json", "once", "force", "keys", "no-launch"]);

export function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (BOOL_FLAGS.has(k)) flags[k] = true;
      else if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length) flags[k] = argv[++i];
      else throw usage(`--${k} needs a value`);
    } else args.push(a);
  }
  return { args, flags };
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "heavy") return await cmdHeavy(rest);
    const { args, flags } = parseArgs(rest);
    const out = (value, human) => {
      process.stdout.write(flags.json ? JSON.stringify(value, null, 2) + "\n" : human() + "\n");
      return 0;
    };
    switch (cmd) {
      case "config":
        return cmdConfig(args, out);
      case "job":
        return await cmdJob(args, flags, out);
      case "watch":
        return await cmdWatch(flags, out);
      case "peek":
        return cmdPeek(args, flags, out);
      case "send":
        return cmdSend(args, flags, out);
      case "land":
        return cmdLand(args, flags, out);
      case "done":
        return cmdDone(args, flags, out);
      case "brief":
        return cmdBrief(args, flags, out);
      default:
        throw usage(
          "usage: brainz-orch <config|job|watch|peek|send|heavy|land|done|brief> … (see the header of this script)",
        );
    }
  } catch (e) {
    if (!(e instanceof OrchError)) throw e;
    process.stderr.write(`brainz-orch: ${e.message}\n`);
    return e.code;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
