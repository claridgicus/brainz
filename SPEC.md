# Brainz — Product Knowledge Graph for Agent Orchestration

## Vision

Brainz is an Obsidian-like knowledge vault whose primary consumer is **not a human — it's an orchestrator agent**. A product's concepts (features, decisions, constraints, patterns, glossary) live as markdown notes linked into a graph. Coding agents working on a feature query Brainz over **MCP** to pull only the concepts relevant to their task — so the orchestrator's context stays clean and subagents get precise, curated product knowledge.

## Monorepo layout (npm workspaces)

```
brainz/
  package.json            # workspaces: ["packages/*"], name: "brainz-monorepo", private
  tsconfig.base.json      # strict, ES2022, NodeNext modules, composite refs
  packages/
    core/                 # @brainz/core   — vault engine (parse, index, search, graph)
    mcp-server/           # @brainz/mcp-server — MCP stdio server over core
    cli/                  # @brainz/cli    — `brainz` command
    web/                  # @brainz/web    — local graph-view web app
  examples/
    demo-vault/           # seeded example vault (a fictional SaaS product)
```

- Node >= 20, TypeScript ~5.5, ESM throughout (`"type": "module"`).
- Build: `tsc -b` per package; web frontend bundled with `esbuild`.
- Tests: `vitest` in each package. Root scripts: `build`, `test`, `typecheck`.

## Vault format

A vault is a directory:

```
my-vault/
  brainz.config.json      # { "name": "...", "embedding": { "provider": "cloudflare" | "local" | "none" } }
  concepts/               # all *.md notes, may be nested in subfolders
  .brainz/                # derived data, gitignored: index.db (SQLite)
```

### Note format

```markdown
---
id: auth-session-model        # slug; defaults to filename-without-ext; unique per vault
title: Auth Session Model
type: concept                 # concept | feature | decision | constraint | pattern | glossary
product: acme-app             # optional grouping key
tags: [auth, backend]
status: active                # active | draft | deprecated
relations:                    # optional TYPED edges (in addition to inline wiki-links)
  depends_on: [jwt-tokens]
  part_of: [auth-system]
---

Body is markdown. Inline [[jwt-tokens]] wiki-links create edges of
relation "references". [[jwt-tokens|display text]] also supported.
```

Edge types: `references` (inline links) plus any key under `relations:` (conventional: `depends_on`, `part_of`, `constrains`, `supersedes`, `related_to`). Edges are directed; traversal may follow both directions.

## `@brainz/core` public API (exact contract — other packages import this)

```ts
// ---- types ----
export type ConceptType = "concept" | "feature" | "decision" | "constraint" | "pattern" | "glossary";
export type ConceptStatus = "active" | "draft" | "deprecated";

export interface ConceptMeta {
  id: string; title: string; type: ConceptType; status: ConceptStatus;
  product?: string; tags: string[]; filePath: string;      // absolute path
  createdAt?: string; updatedAt?: string;                  // ISO dates from frontmatter if present
}
export interface Concept extends ConceptMeta { body: string /* markdown body sans frontmatter */; }

export interface Edge { from: string; to: string; relation: string; }

export interface SearchOptions {
  query: string; mode?: "hybrid" | "keyword" | "semantic";  // default "hybrid"
  product?: string; tags?: string[]; type?: ConceptType; limit?: number; // default 10
}
export interface SearchHit { concept: ConceptMeta; score: number; snippet: string; }

export interface RelatedOptions { depth?: number /* default 1, max 3 */; limit?: number; relations?: string[]; }
export interface RelatedNode { concept: ConceptMeta; distance: number; via: Edge[]; }

export interface ContextOptions {
  query?: string;            // seed via search…
  ids?: string[];            // …or explicit seeds (at least one of query/ids)
  product?: string; depth?: number /* default 1 */;
  tokenBudget?: number;      // default 4000; approx tokens = chars/4
}
export interface ContextBundle {
  markdown: string;          // assembled, ready to inject into an agent prompt
  included: ConceptMeta[]; truncated: boolean; approxTokens: number;
}

export interface UpsertInput {
  id?: string; title: string; body: string; type?: ConceptType; status?: ConceptStatus;
  product?: string; tags?: string[]; relations?: Record<string, string[]>;
}
export interface VaultStats { concepts: number; edges: number; products: string[]; tags: string[]; byType: Record<string, number>; }

// ---- entry point ----
export class Vault {
  static open(dir: string): Promise<Vault>;   // creates dirs/config if missing, opens SQLite, reindexes stale files
  readonly dir: string;
  reindex(): Promise<void>;                    // full rebuild from markdown (source of truth)
  watch(onChange?: () => void): () => void;    // chokidar watcher, returns stop fn
  search(opts: SearchOptions): Promise<SearchHit[]>;
  getConcept(id: string): Concept | null;
  related(id: string, opts?: RelatedOptions): RelatedNode[];
  edges(): Edge[];                             // all edges (for graph view)
  listConcepts(filter?: { product?: string; type?: ConceptType; tag?: string }): ConceptMeta[];
  assembleContext(opts: ContextOptions): Promise<ContextBundle>;
  upsertConcept(input: UpsertInput): Promise<Concept>;   // writes/updates the .md file, reindexes it
  link(from: string, to: string, relation?: string): Promise<void>; // default "related_to"; edits frontmatter of `from`
  stats(): VaultStats;
  close(): void;
}
```

### Index & search internals

- SQLite via `better-sqlite3`; tables `concepts`, `edges`, FTS5 table `concepts_fts(title, body, tags)`, `embeddings(id, vector BLOB /* float32 */)`. Content hash per file to skip unchanged notes on reindex.
- **Keyword**: FTS5 bm25. **Semantic**: cosine over embeddings, computed in JS (fine ≤ ~10k nodes). **Hybrid**: reciprocal-rank-fusion of the two lists.
- Embeddings pluggable: `cloudflare` (default; Workers AI REST API `POST /accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`, auth `Bearer CLOUDFLARE_API_TOKEN`, 768-dim — the SAME model Brainz Cloud uses, so vectors are portable between local vaults and brainz.brownmatter.ai; batch texts per request where the API allows) | `local` (`@xenova/transformers`, `Xenova/all-MiniLM-L6-v2`, lazy-loaded, fully offline) | `none`. If the configured provider fails (offline, missing `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`, absent optional package), **degrade gracefully to keyword-only** — never crash. `embeddingStatus` reflects it. (History: an `openai` provider shipped in v1 and was removed in favor of `cloudflare` — a vault config still saying `openai` should be treated as `cloudflare`-with-warning or `none`, not a crash.)
- `assembleContext`: seed nodes (search hits or ids) → expand graph to `depth` → rank (seed score, then distance) → concatenate as `## <title> (<id>)` sections until `tokenBudget`; set `truncated` if cut.

## `@brainz/mcp-server` — MCP tools (stdio, `@modelcontextprotocol/sdk`)

Env/arg: vault dir via `--vault <dir>` or `BRAINZ_VAULT` (default cwd). Binary: `brainz-mcp`.

| tool | input | returns |
|---|---|---|
| `search_concepts` | `{query, mode?, product?, tags?, type?, limit?}` | hits: id, title, type, score, snippet |
| `get_concept` | `{id}` | full markdown + meta + direct neighbors list |
| `get_related` | `{id, depth?, limit?, relations?}` | related nodes w/ distance & path relations |
| `get_context` | `{query?, ids?, product?, depth?, tokenBudget?}` | **the flagship**: assembled markdown bundle for injection into a coding agent's prompt |
| `upsert_concept` | `{id?, title, body, type?, product?, tags?, relations?}` | saved concept meta |
| `link_concepts` | `{from, to, relation?}` | ok |
| `list_concepts` | `{product?, type?, tag?}` | metas |
| `vault_stats` | `{}` | VaultStats |

Tool descriptions must tell an orchestrator **when** to call them (e.g. get_context: "Call before delegating a coding task; inject result into the subagent prompt."). All responses are JSON text content; get_context returns the markdown directly.

### MCP tool annotations

Every tool in every registry (`MCP_TOOLS`, `PUBLIC_MCP_TOOLS`, `CLOUD_MCP_TOOLS` in `@brainz/contracts`) declares a `title` and an explicit, complete `annotations` set — `readOnlyHint`, `destructiveHint`, `openWorldHint`, all true/false, none omitted (`toolAnnotationsSchema`). The stdio server and both cloud `/mcp` surfaces register them verbatim as MCP `ToolAnnotations` (plus `title`), so `tools/list` carries them. Meanings: **readOnly** = never changes vault/account state; **destructive** = may delete or overwrite existing data (false = additive writes or task-state transitions only); **openWorld** = reaches outside Brainz (sends email, calls an external LLM). These are the justifications submitted to the Anthropic/OpenAI directories; a change to a handler's side effects must update its row here and in `registry-integrity.test.ts`.

| tool | readOnly | destructive | openWorld | why |
|---|---|---|---|---|
| `search_concepts`, `get_concept`, `get_related`, `get_context`, `list_concepts`, `vault_stats`, `list_tasks` | ✓ | — | — | pure reads of this vault's index |
| `session_hook` | ✓ | — | — | returns a playbook text; the caller applies any edits itself |
| `upsert_concept` | — | ✓ | — | overwrites an existing note's title/body/fields when the id exists |
| `delete_concept` | — | ✓ | — | permanently removes a concept and its outgoing edges |
| `dream` | — | ✓ | ✓ | `run` merges/tombstones duplicates (`revert` restores preimages); REM calls an LLM provider (Workers AI or the account's BYOK key) |
| `link_concepts` | — | — | — | adds an edge to frontmatter |
| `create_task` | — | — | — | creates a new task concept |
| `take_task`, `complete_task` | — | — | — | task lifecycle transitions; `complete_task` appends an Outcome section |
| `onboard`, `sync` | — | — | — | `start`/`status` read; `complete` stamps onboarding/sync time and writes or appends the vault's own onboarding-summary note |
| `signup` | — | — | ✓ | provisions a new workspace; with `email` it sends a claim email |
| `sign_in` | — | — | ✓ | emails a magic sign-in link |
| `claim` (cloud) | — | — | ✓ | emails a claim-approval link |

## `@brainz/cli` — `brainz` binary (commander)

```
brainz init [dir]                      # scaffold vault + config + sample note
brainz add <title> [--type --product --tags --body|--stdin]
brainz search <query> [--mode --product --limit]
brainz show <id>
brainz related <id> [--depth]
brainz link <from> <to> [--relation]
brainz context (--query <q> | --ids a,b) [--budget N]
brainz reindex | validate              # validate: broken links, dup ids, bad frontmatter → exit 1 on errors
brainz mcp [--vault dir]               # run MCP stdio server
brainz web [--vault dir --port 4680]   # run graph-view web app
```

Global `--vault <dir>` (default cwd). Human-readable output; `--json` flag for machine output.

## `@brainz/web` — graph view

- Small HTTP server (node http or express) on `--port` (default 4680): serves static frontend + JSON API: `GET /api/graph` (nodes+edges), `GET /api/concept/:id` (incl. body), `GET /api/search?q=`, `GET /api/stats`.
- Frontend: single page, **no framework needed** (or lightweight): force-directed graph via `d3-force` rendered to SVG/canvas. Color by `type`, size by degree. Click node → side panel with rendered markdown (use `marked`), list of edges, button to focus neighborhood. Search box filters/highlights. Dark theme.
- Bundle with esbuild to `dist/public`; no CDN dependencies at runtime.

## Conventions

- Never throw raw exceptions across the MCP boundary — return `isError` content.
- All ids are slugs: lowercase alnum + dashes; `slugify()` lives in core.
- Wiki-links to unknown ids are allowed (they're "pending" concepts); `validate` reports them as warnings, not errors.

## Orchestration (`integrations/claude-code/brainz-orchestrate`)

A Claude Code plugin that turns one Claude session into an **orchestrator**. It keeps the work pile as Brainz tasks, launches each task as a separate `claude` worker process in its own git worktree, throttles heavy steps, relays workers' questions, and reviews and lands their branches. The engine is the Brainz task lifecycle (`list_tasks` / `take_task` / `complete_task` / `create_task` / `upsert_concept` / `get_concept`), reached over whatever Brainz MCP connection the user already has. The plugin adds **no MCP tool and no new task field**; all local work goes through one zero-dependency script. The directory-listed `/mcp` surface is untouched.

### Layout

```
.claude-plugin/marketplace.json     # repo-root marketplace "brainz" listing the plugin
integrations/claude-code/brainz-orchestrate/
  .claude-plugin/plugin.json        # plugin manifest (name "brainz-orchestrate")
  skills/orchestrate/SKILL.md       # /orchestrate: the orchestrator loop
  skills/orchestrate/worker-brief.md  # worker contract template ({{TASK}} {{PATH}} {{BRANCH}} {{BASE}} {{REPO}} {{ORCH}} {{EXTRA}})
  scripts/brainz-orch.mjs           # Node >= 20, no dependencies; the only executable
  test/*.test.mjs                   # node:test, run by the root `npm test`
  README.md
```

### Workers and the multiplexer

Each worker is a separate `claude` process (command and args from config `worker`, the rendered brief as the last argument) running in its worktree `<repo>-<branch>`, a sibling of the main checkout, so a user can jump into any worker. **tmux is the multiplexer**, and it is detected, never required:
- inside tmux (`$TMUX` set): one window per job, named after the branch, in the current session;
- tmux installed but not inside it: one window per job in a detached session `brainz-<repo>` (`tmux attach -t brainz-<repo>`);
- no tmux (or `--no-launch`): `job start` prints `cd <worktree> && claude … "$(cat <brief>)"` for the user to run, and `watch` can't see that worker; the orchestrator relies on the user and on Brainz task state for it.

### `brainz-orch` commands

State lives in `<git-common-dir>/brainz-orchestrate/` (never tracked, shared by every worktree): `config.json`, `jobs.json` (branch → task, worktree path, base, brief, tmux pane, startedAt), `briefs/<branch>.md`, `watch.json`. The heavy-slot locks live in `~/.cache/brainz-orchestrate/heavy` (machine-wide). `--json` gives machine output. Exit 0 = ok, 1 = a failure it reports, 2 = bad usage.

| command | does |
|---|---|
| `config set <file\|->` / `config show` | Caches the `orchestrate-config` concept (its markdown, or raw JSON) after validating it: unknown keys and bad types are rejected. `show` prints the effective config with defaults filled in. |
| `job start <task-id> [--branch b] [--base ref] [--no-launch]` | `git fetch`, then reuses the worktree already checked out on `<branch>` or runs `git worktree add [-b <branch>] <repo>-<branch> <base>`. Runs `setup` in a new worktree, renders the brief, launches the worker (see above) and records the job. The branch defaults to the task id cut to 40 chars; the base defaults to `origin/<mainBranch>`. Refuses when `concurrency` other jobs are open. A job whose pane is still alive is reused, not relaunched. |
| `job list` | Open jobs with `ahead` (commits over base), `dirty`, `paneAlive`, `lastActivity` (the newest of startedAt, the HEAD commit time and changed files' mtimes) and `stale` (no activity for `leaseMinutes`). |
| `watch [--once] [--interval s] [--idle s]` | Polls every tmux job pane (default every 15s) and exits, printing the events, as soon as one pane is `ready`/`stuck` (its last lines end with the contract line and the pane is unchanged over one poll), `idle` (unchanged for `idleSeconds` with no contract line, usually an AskUserQuestion menu or a permission prompt) or `gone` (the pane no longer exists). Each pane state is reported once (`watch.json`), so re-running after a wake-up is safe. It replaces herdr's `mwatch`. |
| `peek <branch> [--lines n]` | Prints the worker pane's recent output. |
| `send <branch> <text…>` / `send <branch> --keys <key…>` | Types a reply and presses Enter, or sends raw tmux keys (a menu choice). Clears the pane's watch state so its next stop is reported. |
| `heavy -- <cmd…>` | Runs `<cmd>` in one of `heavySlots` machine-wide slots: atomic `mkdir` lock dirs with the holder's pid, and a dead holder's slot is reclaimed. It is pinned with `taskset -c <heavyCpus>` when that is configured and `taskset` exists. It waits for a slot by polling and exits with the command's code. `BRAINZ_ORCH_HEAVY_SLOTS` / `BRAINZ_ORCH_HEAVY_CPUS` override the config per machine. |
| `land <branch> [--mode push\|pr]` | In the job's worktree: refuses if it is dirty; fetches; rebases onto `origin/<main>` (a conflict aborts the rebase and fails); runs every `gates` command through `heavy`; re-checks that `origin/<main>` is still an ancestor. Then **pr** (the default) pushes the branch (`--force-with-lease`, the worker's own branch only) and runs `gh pr create --fill`, or reuses the open PR. **push** fast-forwards `origin/<main>` (`git push origin HEAD:<main>`, never forced). It stops at the first failure and pushes nothing. Without `gh` the branch is pushed and the PR is left to the user. |
| `done <branch> [--force]` | Kills the job's pane, removes the worktree, deletes the branch and drops the job. Without `--force` it refuses unless the worktree is clean and its HEAD is on `origin/<main>` or equals `origin/<branch>`. |
| `brief <task-id> [--branch b]` | Prints the rendered worker brief without creating anything. |

### Worker contract (JOB READY / STUCK)

The brief (`worker-brief.md`, plus the config's `workerExtra`) tells a worker to:
1. Call `take_task` with the task id and `takenBy: orch:<branch>`, read the briefing, and call `get_context` if needed.
2. Work only inside its worktree. Never edit, stash, reset or check out anything in the main checkout or another worktree. Never push or merge.
3. Run tests, typecheck, lint, builds, local stacks and `git commit` through `node <script> heavy -- …` (the absolute path is rendered into the brief).
4. Follow the repo's agent rules and commit on its branch with hooks running (never `--no-verify`).
5. Never call `complete_task`; the orchestrator does that after landing.
6. Finish with a short report (what changed, commits, gates run, what was tried live, risks) and **exactly one final line, without backticks**: `JOB READY <task-id>` or `JOB STUCK <task-id>: <why>`. A decision only the user can make is either an AskUserQuestion (`watch` sees the pane go `idle`) or a `JOB STUCK` whose reason is the question. The orchestrator relays it and types the answer back with `send`.

`watch` matches the contract line only in the pane's last 15 non-blank lines, and skips lines that contain a backtick or `<why>`, so the echoed brief never counts as a finish.

### Task state (existing fields + tags)

Orchestration state rides on fields tasks already have, written with the lifecycle tools or with `upsert_concept` (title and body unchanged):

| state | encoding |
|---|---|
| queued | `taskStatus: open`, tag `ready` (or `needs-<person>` while blocked on a decision) |
| running | `taskStatus: taken`, `takenBy: orch:<branch>` (set by the worker's `take_task`) |
| awaiting review | tag `job-review` (orchestrator, on `ready`) |
| stuck | tag `job-stuck` (on `stuck`; removed when the worker resumes) |
| PR open | tag `job-pr`, plus a `## Pull request` section with the URL appended to the body |
| landed | `complete_task` with the commit hash or PR URL and what was and wasn't verified (PR mode: once merged); all `job-*` tags removed |

**Lease.** A task is leased while its `orch:` job exists on this machine and shows activity. `job list` marks a job `stale` after `leaseMinutes` without commits or file changes. The orchestrator then peeks the worker and either nudges it or releases the task (`upsert_concept` with `taskStatus: open`, tag `released`) and runs `done --force` after the user confirms. A task `taken` by an `orch:` label with no job record here belongs to another orchestrator and is left alone.

### Per-repo config (the `orchestrate-config` vault concept)

The repo's config is the vault concept **`orchestrate-config`** (type `pattern`), so every orchestrator and teammate uses the same rules. Its prose becomes `workerExtra` (appended to every brief), and its first fenced `json` block holds the settings. All keys are optional:

| key | default | |
|---|---|---|
| `setup` | `[]` | shell commands run in a new worktree before the worker starts |
| `gates` | `[]` | shell commands `land` runs through `heavy` after the rebase |
| `concurrency` | `3` | open jobs at once |
| `heavySlots` / `heavyCpus` | `2` / unset | heavy-step semaphore and optional `taskset` CPU list |
| `landing` | `"pr"` | `"pr"` or `"push"` (the brainz repo itself uses `"push"`) |
| `mainBranch` | origin's default branch, else `main` | landing target |
| `leaseMinutes` | `60` | inactivity before a job is `stale` |
| `idleSeconds` | `120` | how long a pane must be unchanged before `watch` reports it as `idle` |
| `worker` | `{"command":"claude","args":[]}` | worker process; the brief is appended as the last argument |
| `workerExtra` | the concept's prose | extra worker rules |

At start-up the orchestrator reads the concept with `get_concept` and caches it with `config set -`. If the concept is absent, defaults apply and the skill offers to create it.

### Orchestrator loop (`/orchestrate`)

1. Start-up: cache the config; `list_tasks` (open and taken); `job list` to adopt jobs from an earlier session; start `watch` in the background.
2. New work becomes a task (`create_task` with a body, `codeAreas` and tags).
3. Launch `ready` tasks with `job start`, up to `concurrency`, and never two that edit the same files.
4. On a `watch` event, `peek` the worker. `idle`/`stuck`: relay the question to the user, answer only from what the user said, `send` the answer. `ready`: tag `job-review`, then review (`git log`/`diff origin/<main>...HEAD`, uncommitted leftovers, the gates the worker ran), `land`, and on failure `send` the worker what to fix. `gone`: relaunch or release.
5. After landing: push mode runs `complete_task` and then `done`. PR mode tags `job-pr`, runs `done`, and runs `complete_task` once the PR is merged.
6. Never land unreviewed work, never `--no-verify`, never force-push the main branch; never stash, reset or check out in the main checkout.
