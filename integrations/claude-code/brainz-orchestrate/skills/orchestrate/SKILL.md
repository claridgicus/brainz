---
name: orchestrate
description: Run this Claude Code session as a Brainz orchestrator. One thread keeps the work pile as Brainz tasks and launches each task as a Claude worker in its own git worktree (a tmux window). It throttles heavy steps, watches the workers, relays their questions, and reviews and lands their branches. Use when the user says /orchestrate, "be the orchestrator", "manage the jobs", "launch a job for X", or wants many agents worked from one managing thread.
---

# Brainz orchestrator

You orchestrate the git repo in this session's cwd. You **don't write product code yourself**: you keep the task pile in Brainz, launch workers, unblock them, review their branches and land them. Brainz is reached through its MCP tools (`list_tasks`, `take_task`, `create_task`, `complete_task`, `get_concept`, `upsert_concept`, `get_context`). If they aren't connected, stop and tell the user to connect Brainz first.

All local work goes through one script. Call it as
`node "${CLAUDE_PLUGIN_ROOT}/scripts/brainz-orch.mjs" <command>`, written `orch <command>` below. If `CLAUDE_PLUGIN_ROOT` is empty, the script is `../../scripts/brainz-orch.mjs` relative to this skill's directory. Add `--json` when you parse the output.

| command | does |
|---|---|
| `orch config set <file\|->` / `config show` | Caches the repo's `orchestrate-config` concept (markdown or JSON on stdin) and shows the effective config |
| `orch job start <task-id> [--branch b] [--base ref]` | Creates the worktree `<repo>-<branch>` beside the repo, runs `setup`, renders the worker brief, and starts `claude` with it in a tmux window. Without tmux it prints the command for the user to run |
| `orch job list` | Lists open jobs: commits ahead, dirty, tmux pane, last activity, `STALE` past the lease |
| `orch watch` | Blocks until a worker printed `JOB READY`/`JOB STUCK`, went quiet (`idle`, usually a question or permission prompt), or lost its pane (`gone`), then prints it and exits. Run it with Bash `run_in_background: true` and re-run it after handling each wake-up |
| `orch peek <branch> [--lines n]` | Reads the worker's tmux pane |
| `orch send <branch> <text>` / `send <branch> --keys <key…>` | Types a reply and presses Enter, or sends raw keys (`1`, `Enter`, `Down`) to answer a menu |
| `orch heavy -- <cmd…>` | Runs a heavy step in the machine-wide slot queue (workers use it for tests, builds and commits) |
| `orch land <branch> [--mode push\|pr]` | Rebases onto `origin/<main>`, runs the gates, then opens a PR or fast-forward pushes main. It stops at the first failure and pushes nothing |
| `orch done <branch> [--force]` | Closes the pane and removes the worktree and branch once the work is landed |

## Start-up
1. `get_concept` `orchestrate-config`. If it exists, pipe its body to `orch config set -`. If it doesn't, offer to create it with `upsert_concept` (type `pattern`; prose rules for workers plus one ```json block with `setup`, `gates`, `concurrency`, `landing`, …; see the plugin README) and use defaults until then.
2. Survey: `list_tasks` (`open` and `taken`), `orch job list` (adopt jobs left by an earlier session), `orch config show`.
3. Start `orch watch` in the background.

## Loop
1. **New work becomes a task.** `create_task` with a clear body, `codeAreas` and tags (`ready`, or `needs-<person>` while it waits on a decision). Run `get_context` for an area before launching into it if you're unsure what governs it.
2. **Launch** `ready` tasks with `orch job start`, up to `concurrency`. Don't co-launch tasks that edit the same files: queue the later one. Don't launch a task that is `taken` by someone else. If the script printed a manual command (no tmux), give it to the user and ask them to tell you when the worker finishes.
3. **On a wake-up** (`orch watch` exited), `orch peek` the worker:
   - `idle`: it's asking something (AskUserQuestion menu, permission prompt) or it stopped. Relay the question to the user in a line or two. Answer it yourself only when the user already decided it (quote where). Use `orch send` to type the answer, or `orch send <b> --keys <n>` to pick a menu option.
   - `stuck`: tag the task `job-stuck` (`upsert_concept`, title/body unchanged), relay the reason, and when you have the answer `orch send` it and drop the tag.
   - `ready`: tag `job-review`, then **review**: `git -C <worktree> log origin/<main>..HEAD`, `git -C <worktree> diff origin/<main>...HEAD`, `git -C <worktree> status --short`. Check that it does what the task asked, follows the repo's rules, and that the gates it reports passed. Then `orch land <branch>`. If landing fails (conflict, gate, main moved), `orch send` the worker what to fix and review again.
   - `gone`: the worker exited. Check `orch job list` and the task; relaunch (`orch job start` reuses the worktree) or release it.
4. **After landing:** push mode → `complete_task` with the commit hash and what was and wasn't verified, then `orch done <branch>`. PR mode → tag `job-pr`, append `## Pull request` + the URL to the body, `orch done <branch>`; `complete_task` once the PR is merged. Remove `job-*` tags at completion. Launch whatever the landing unblocked.
5. **Stale leases:** a job `STALE` in `orch job list` has had no commits or file changes for `leaseMinutes`. Peek it. If it's dead, release the task (`upsert_concept` with `taskStatus: open`, tag `released`) and `orch done <branch> --force` after confirming with the user that nothing in it is worth keeping. A task `taken` by an `orch:` label with no job here belongs to another orchestrator: leave it alone.
6. Re-run `orch watch`. Report each landing or blocker to the user in a few lines; don't narrate the waiting.

## Rules
- Never land unreviewed work, never `--no-verify`, never force-push the main branch.
- Never stash, reset or check out in the main checkout: other sessions share it.
- A background notification is not the user's approval. Only answer a worker's approval question from something the user actually said.
- Don't close a worker that is still working without asking.
- Never call `complete_task` before the work is on the main branch (push) or merged (PR).
