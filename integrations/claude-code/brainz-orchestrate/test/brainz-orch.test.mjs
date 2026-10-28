import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultBranch, finalMarker, parseConfigSource, q, tryAcquireSlot } from "../scripts/brainz-orch.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/brainz-orch.mjs", import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brainz-orch-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sh(cmd, cwd) {
  const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare origin with one commit on main, and a clone of it. */
function makeRepo(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root);
  sh(`git init -q --bare -b main origin.git`, root);
  sh(`git clone -q origin.git repo 2>/dev/null; cd repo && git checkout -q -b main && echo a > a.txt && git add . && git commit -qm init && git push -q origin main`, root);
  sh(`git remote set-head origin main`, path.join(root, "repo"));
  return { root, repo: path.join(root, "repo"), origin: path.join(root, "origin.git") };
}

/** Fake tmux: logs calls, panes are files under $dir/panes, capture prints the pane file. */
function fakeTmux(dir) {
  fs.mkdirSync(path.join(dir, "panes"), { recursive: true });
  const bin = path.join(dir, "tmux");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
d=${q(dir)}
echo "$*" >> "$d/log"
case "$1" in
  has-session) exit 1 ;;
  new-session|new-window) n=$(ls "$d/panes" | wc -l); p="%$((n+1))"; : > "$d/panes/$p"; echo "$p" ;;
  display-message) t=$4; [ -f "$d/panes/$t" ] && echo "$t" || exit 1 ;;
  capture-pane) t=$5; [ -f "$d/panes/$t" ] && cat "$d/panes/$t" || exit 1 ;;
  kill-pane) rm -f "$d/panes/$3" ;;
  send-keys) : ;;
esac
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

function orch(args, { cwd, env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, BRAINZ_ORCH_HEAVY_DIR: path.join(tmp, "heavy"), TMUX: "", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

describe("helpers", () => {
  test("defaultBranch cuts to 40 chars without a trailing dash", () => {
    assert.equal(defaultBranch("short-task"), "short-task");
    assert.equal(defaultBranch("design-ship-an-orchestrate-style-multi-agent-workflow"), "design-ship-an-orchestrate-style-multi-a");
    assert.equal(defaultBranch("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-b"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("parseConfigSource reads the json fence and keeps the prose as workerExtra", () => {
    const md = "---\nid: orchestrate-config\n---\nRun npm install first.\n\n```json\n{\"gates\": [\"npm test\"], \"landing\": \"push\"}\n```\n";
    assert.deepEqual(parseConfigSource(md), { gates: ["npm test"], landing: "push", workerExtra: "Run npm install first." });
    assert.deepEqual(parseConfigSource('{"concurrency": 5}'), { concurrency: 5 });
    assert.deepEqual(parseConfigSource("just prose"), { workerExtra: "just prose" });
  });

  test("parseConfigSource rejects unknown keys and bad types", () => {
    assert.throws(() => parseConfigSource('{"gate": []}'), /unknown key "gate"/);
    assert.throws(() => parseConfigSource('{"landing": "merge"}'), /"landing"/);
    assert.throws(() => parseConfigSource('{"concurrency": 0}'), /"concurrency"/);
    assert.throws(() => parseConfigSource('{"worker": {"args": []}}'), /"worker"/);
    assert.throws(() => parseConfigSource("```json\n{nope\n```"), /invalid JSON/);
  });

  test("finalMarker finds the worker's last line but not the echoed brief", () => {
    assert.deepEqual(finalMarker("did things\n⏺ JOB READY fix-x\n\n> \n"), { state: "ready", task: "fix-x", reason: null });
    assert.deepEqual(finalMarker("  JOB STUCK fix-x: which DB?\n"), { state: "stuck", task: "fix-x", reason: "which DB?" });
    const brief = "   `JOB READY fix-x`  — or, if you cannot go on, `JOB STUCK fix-x: <why>`\n";
    assert.equal(finalMarker(brief), null);
    assert.equal(finalMarker("JOB READY fix-x\n" + "more\n".repeat(20)), null);
  });

  test("heavy slots are exclusive and dead holders are reclaimed", () => {
    const dir = path.join(tmp, "slots");
    const a = tryAcquireSlot(dir, 2);
    const b = tryAcquireSlot(dir, 2);
    assert.ok(a && b && a !== b);
    assert.equal(tryAcquireSlot(dir, 2), null);
    fs.writeFileSync(path.join(a, "pid"), "999999999"); // a holder that no longer exists
    assert.equal(tryAcquireSlot(dir, 2), a);
  });
});

describe("heavy", () => {
  test("runs the command and passes its exit code through", () => {
    assert.equal(orch(["heavy", "--", "sh", "-c", "exit 3"], { cwd: tmp }).code, 3);
    const r = orch(["heavy", "--", "sh", "-c", "echo hi"], { cwd: tmp });
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), "hi");
  });

  test("a second heavy step waits for the slot", () => {
    const marks = path.join(tmp, "marks");
    const cmd =
      `BRAINZ_ORCH_HEAVY_SLOTS=1 BRAINZ_ORCH_HEAVY_DIR=${q(path.join(tmp, "heavy-one"))} ` +
      `${q(process.execPath)} ${q(SCRIPT)} heavy -- sh -c 'echo start >> ${marks}; sleep 1; echo end >> ${marks}'`;
    sh(`(${cmd}) & (sleep 0.3; ${cmd}) & wait`, tmp);
    assert.deepEqual(fs.readFileSync(marks, "utf8").trim().split("\n"), ["start", "end", "start", "end"]);
  });
});

describe("jobs, watch and landing", () => {
  let r;
  let tmuxDir;
  let env;
  beforeEach((t) => {
    r = makeRepo(t.name.replace(/\W+/g, "-"));
    tmuxDir = path.join(r.root, "tmux");
    env = { BRAINZ_ORCH_TMUX: fakeTmux(tmuxDir) };
  });

  test("job start creates the worktree, runs setup, renders the brief and opens a tmux window", () => {
    const cfg = '```json\n{"setup": ["touch setup-ran"], "landing": "push"}\n```\nUse small commits.';
    assert.equal(orch(["config", "set", "-"], { cwd: r.repo, input: cfg, env }).code, 0);
    const res = orch(["job", "start", "fix-login-bug", "--json"], { cwd: r.repo, env });
    assert.equal(res.code, 0, res.err);
    const job = res.json();
    assert.equal(job.branch, "fix-login-bug");
    assert.equal(job.path, path.join(r.root, "repo-fix-login-bug"));
    assert.equal(job.base, "origin/main");
    assert.ok(fs.existsSync(path.join(job.path, "setup-ran")));
    assert.equal(sh("git rev-parse --abbrev-ref HEAD", job.path), "fix-login-bug");
    const brief = fs.readFileSync(job.brief, "utf8");
    assert.match(brief, /take_task` with id `fix-login-bug` and takenBy `orch:fix-login-bug`/);
    assert.match(brief, /Use small commits\./);
    assert.match(brief, /brainz-orch\.mjs' heavy -- npm test/);
    assert.ok(!brief.includes("{{"));
    assert.equal(job.launch.mode, "tmux");
    assert.equal(job.launch.session, "brainz-repo");
    const log = fs.readFileSync(path.join(tmuxDir, "log"), "utf8");
    assert.match(log, /new-session -d -s brainz-repo -n fix-login-bug/);
    assert.match(log, /send-keys -t %1 -l cd .*repo-fix-login-bug.* && 'claude' "\$\(cat /);

    // Starting it again reuses the worktree and the live pane.
    const again = orch(["job", "start", "fix-login-bug", "--json"], { cwd: r.repo, env }).json();
    assert.equal(again.created, false);
    assert.equal(again.launch.reused, true);

    const list = orch(["job", "list", "--json"], { cwd: r.repo, env }).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].ahead, 0);
    assert.equal(list[0].paneAlive, true);
    assert.equal(list[0].stale, false);
  });

  test("--no-launch prints the command to run and concurrency is enforced", () => {
    orch(["config", "set", "-"], { cwd: r.repo, input: '{"concurrency": 1}', env });
    const job = orch(["job", "start", "task-a", "--no-launch", "--json"], { cwd: r.repo, env }).json();
    assert.equal(job.launch.mode, "manual");
    assert.match(job.launch.command, /^cd '.*repo-task-a' && 'claude' "\$\(cat '.*task-a\.md'\)"$/);
    assert.ok(!fs.existsSync(path.join(tmuxDir, "log")));
    const second = orch(["job", "start", "task-b"], { cwd: r.repo, env });
    assert.equal(second.code, 1);
    assert.match(second.err, /concurrency 1 reached/);
  });

  test("watch reports ready once the pane settles, then stays quiet", () => {
    const job = orch(["job", "start", "task-w", "--json"], { cwd: r.repo, env }).json();
    const pane = path.join(tmuxDir, "panes", job.launch.pane);
    fs.writeFileSync(pane, "working…\n⏺ JOB READY task-w\n");
    const w = (args = []) => orch(["watch", "--once", "--json", ...args], { cwd: r.repo, env }).json();
    assert.deepEqual(w(), []); // first sight: not settled yet
    assert.deepEqual(w(), [{ branch: "task-w", task: "task-w", pane: job.launch.pane, state: "ready" }]);
    assert.deepEqual(w(), []); // reported once
    fs.writeFileSync(pane, "more\nJOB STUCK task-w: which region?\n");
    w();
    assert.equal(w()[0].reason, "which region?");
    fs.rmSync(pane);
    assert.equal(w()[0].state, "gone");
  });

  test("watch reports a quiet pane as idle", () => {
    const job = orch(["job", "start", "task-i", "--json"], { cwd: r.repo, env }).json();
    fs.writeFileSync(path.join(tmuxDir, "panes", job.launch.pane), "Do you want to proceed?\n❯ 1. Yes\n");
    const w = () => orch(["watch", "--once", "--json", "--idle", "1"], { cwd: r.repo, env }).json();
    assert.deepEqual(w(), []);
    spawnSync("sleep", ["1.1"]);
    assert.equal(w()[0].state, "idle");
  });

  test("land --mode push rebases, runs gates and fast-forwards main; done cleans up", () => {
    orch(["config", "set", "-"], { cwd: r.repo, input: '{"gates": ["test -f b.txt"]}', env });
    const job = orch(["job", "start", "add-b", "--json"], { cwd: r.repo, env }).json();
    sh("echo b > b.txt && git add b.txt && git commit -qm 'add b'", job.path);
    // main moves meanwhile: land must rebase over it
    sh("echo c > c.txt && git add c.txt && git commit -qm 'add c' && git push -q origin main", r.repo);

    assert.equal(orch(["done", "add-b"], { cwd: r.repo, env }).code, 1); // not landed yet
    const landed = orch(["land", "add-b", "--mode", "push", "--json"], { cwd: r.repo, env });
    assert.equal(landed.code, 0, landed.err);
    const tip = sh("git rev-parse main", r.origin);
    assert.equal(landed.json().commit, tip);
    assert.equal(sh("git log --format=%s -3 main", r.origin), "add b\nadd c\ninit");

    const done = orch(["done", "add-b", "--json"], { cwd: r.repo, env });
    assert.equal(done.code, 0, done.err);
    assert.ok(!fs.existsSync(job.path));
    assert.equal(sh("git branch --list add-b", r.repo), "");
    assert.deepEqual(orch(["job", "list", "--json"], { cwd: r.repo, env }).json(), []);
    assert.match(fs.readFileSync(path.join(tmuxDir, "log"), "utf8"), /kill-pane -t %1/);
  });

  test("land stops on a failing gate and on a conflicting rebase, pushing nothing", () => {
    orch(["config", "set", "-"], { cwd: r.repo, input: '{"gates": ["false"]}', env });
    const job = orch(["job", "start", "edit-a", "--json"], { cwd: r.repo, env }).json();
    sh("echo worker > a.txt && git commit -qam 'worker edit'", job.path);
    const before = sh("git rev-parse main", r.origin);
    const gate = orch(["land", "edit-a", "--mode", "push"], { cwd: r.repo, env });
    assert.equal(gate.code, 1);
    assert.match(gate.err, /gate failed: false/);

    sh("echo main > a.txt && git commit -qam 'main edit' && git push -q origin main", r.repo);
    const conflict = orch(["land", "edit-a", "--mode", "push"], { cwd: r.repo, env });
    assert.equal(conflict.code, 1);
    assert.match(conflict.err, /rebase onto origin\/main conflicted/);
    assert.equal(sh("git status --porcelain", job.path), ""); // rebase aborted
    assert.notEqual(sh("git rev-parse main", r.origin), before); // only main's own push landed
    assert.equal(sh("git log --format=%s -1 main", r.origin), "main edit");
  });

  test("land --mode pr pushes the branch and opens a PR with gh", () => {
    const job = orch(["job", "start", "pr-job", "--json"], { cwd: r.repo, env }).json();
    sh("echo p > p.txt && git add p.txt && git commit -qm 'add p'", job.path);
    const bin = path.join(r.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\necho "$*" >> ${q(path.join(r.root, "gh.log"))}\n[ "$2" = view ] && exit 1\necho https://example.test/pr/1\n`,
    );
    fs.chmodSync(path.join(bin, "gh"), 0o755);
    const ghEnv = { ...env, PATH: `${bin}:${process.env.PATH}` };
    const landed = orch(["land", "pr-job", "--json"], { cwd: r.repo, env: ghEnv });
    assert.equal(landed.code, 0, landed.err);
    assert.equal(landed.json().mode, "pr");
    assert.equal(landed.json().pr, "https://example.test/pr/1");
    assert.match(fs.readFileSync(path.join(r.root, "gh.log"), "utf8"), /pr create --fill --base main --head pr-job/);
    assert.equal(sh("git rev-parse pr-job", r.origin), sh("git rev-parse HEAD", job.path));
    assert.equal(sh("git log --format=%s -1 main", r.origin), "init");
    assert.equal(orch(["done", "pr-job"], { cwd: r.repo, env }).code, 0); // pushed counts as landed
  });

  test("send types a reply into the worker pane", () => {
    orch(["job", "start", "task-s"], { cwd: r.repo, env });
    assert.equal(orch(["send", "task-s", "use", "eu-west"], { cwd: r.repo, env }).code, 0);
    assert.equal(orch(["send", "task-s", "--keys", "1"], { cwd: r.repo, env }).code, 0);
    const log = fs.readFileSync(path.join(tmuxDir, "log"), "utf8");
    assert.match(log, /send-keys -t %1 -l use eu-west\nsend-keys -t %1 Enter/);
    assert.match(log, /send-keys -t %1 1\n/);
    assert.equal(orch(["send", "nope", "x"], { cwd: r.repo, env }).code, 1);
  });

  test("bad usage exits 2", () => {
    assert.equal(orch(["frobnicate"], { cwd: r.repo, env }).code, 2);
    assert.equal(orch(["job", "start"], { cwd: r.repo, env }).code, 2);
    assert.equal(orch(["land", "x", "--mode", "merge"], { cwd: r.repo, env }).code, 2);
  });
});
