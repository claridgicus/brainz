# brainz-orchestrate (Claude Code plugin)

Turns one Claude Code session into an orchestrator over a [Brainz](https://brainz.brownmatter.ai) task pile. The orchestrator keeps the work as Brainz tasks and launches each task as a `claude` worker in its own git worktree, in a tmux window you can jump into. It throttles heavy steps (tests, builds, commits) across workers, relays workers' questions to you, and reviews and lands their branches as PRs or fast-forward pushes. The design is specified in [SPEC.md, "Orchestration"](../../../SPEC.md).

## Install

1. Connect Brainz to Claude Code, either through the cloud MCP server (`https://brainz.brownmatter.ai/mcp`) or a local vault (`brainz mcp`). The plugin itself contains no MCP server.
2. Add the marketplace and install the plugin:

   ```
   /plugin marketplace add claridgicus/brainz
   /plugin install brainz-orchestrate@brainz
   ```

   Or try it from a checkout with `claude --plugin-dir integrations/claude-code/brainz-orchestrate`.
3. Requirements: git, Node >= 20 and `claude` on PATH. tmux is optional but recommended: with it, workers start on their own; without it, `job start` prints the command for you to run. `gh` is needed for PR landing.

Start the orchestrator in your repo with `/orchestrate`.

## How it works

- **Workers** are separate `claude` processes, one per task, each in a sibling worktree `<repo>-<branch>`. Inside tmux each gets a window in your current session. Outside tmux they go into a detached session `brainz-<repo>` (`tmux attach -t brainz-<repo>`).
- **Worker contract:** the worker claims its task with `take_task`, works only in its worktree, runs heavy steps through `brainz-orch heavy`, never pushes, merges or completes the task, and ends with `JOB READY <task>` or `JOB STUCK <task>: <why>`. See [`skills/orchestrate/worker-brief.md`](skills/orchestrate/worker-brief.md).
- **Watching:** `brainz-orch watch` reads the workers' tmux panes and wakes the orchestrator when one prints its final line, goes quiet (a question or permission prompt), or exits.
- **Task state** uses existing Brainz fields and tags: `taken` by `orch:<branch>` while running, plus `job-review`, `job-stuck` and `job-pr`, then `complete_task`. Nothing new is added to the MCP surface.
- **State on disk:** `<git-common-dir>/brainz-orchestrate/` (config cache, jobs, briefs, watch state), which is shared by all worktrees and never tracked. Heavy-step slots live in `~/.cache/brainz-orchestrate/heavy`.

## Per-repo config: the `orchestrate-config` concept

Put the config in the vault so every orchestrator and teammate uses the same rules. Create a concept with id `orchestrate-config` (type `pattern`). Its prose is appended to every worker brief, and one fenced JSON block holds the settings:

````markdown
Workers: run `npm install` before anything else; docs change in the same commit as code.

```json
{
  "setup": ["npm install"],
  "gates": ["npm run build", "npm test"],
  "concurrency": 3,
  "heavySlots": 2,
  "landing": "pr",
  "worker": { "command": "claude", "args": ["--permission-mode", "acceptEdits"] }
}
```
````

| key | default | meaning |
|---|---|---|
| `setup` | `[]` | shell commands run in a new worktree before the worker starts |
| `gates` | `[]` | shell commands `land` runs (through `heavy`) after rebasing; any failure stops the landing |
| `concurrency` | `3` | open jobs at once |
| `heavySlots` | `2` | heavy steps running at once, machine-wide |
| `heavyCpus` | unset | pin heavy steps with `taskset -c <cpus>` (Linux) |
| `landing` | `"pr"` | `"pr"` (push branch + `gh pr create`) or `"push"` (fast-forward `origin/<main>`) |
| `mainBranch` | origin's default | the branch landings target |
| `leaseMinutes` | `60` | a job with no commits or file changes for this long is reported `STALE` |
| `idleSeconds` | `120` | a worker pane unchanged this long wakes the orchestrator as `idle` |
| `worker` | `{"command":"claude","args":[]}` | how a worker is started; the brief is the last argument |
| `workerExtra` | the concept's prose | extra worker rules |

`BRAINZ_ORCH_HEAVY_SLOTS` and `BRAINZ_ORCH_HEAVY_CPUS` override the heavy settings per machine.

## Development

`node --test integrations/claude-code/brainz-orchestrate/test/` (part of the root `npm test`). The script has no dependencies. Keep it that way: users run it straight from the plugin directory.
