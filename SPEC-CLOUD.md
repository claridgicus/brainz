# Brainz Cloud — free hosted knowledge graph on Cloudflare

Extends SPEC.md. Brainz Cloud hosts vaults for everyone, free: sign up, create a vault, point any orchestrator at a remote MCP URL. Local (packages/*) stays fully supported; cloud reuses the same engine.

## New layout

```
packages/engine/    # @brainz/engine    — PURE platform-agnostic logic (no fs, no better-sqlite3, no node-only APIs)
packages/contracts/ # @brainz/contracts — single source of truth for every wire shape (zod)
apps/cloud/         # SvelteKit app → ONE Cloudflare Worker: UI + REST API + remote MCP
```
Root workspaces become `["packages/*", "apps/*"]`.

## `@brainz/contracts` — wire-shape source of truth (zod)

Purpose: the MCP server, CLI `--json` output, cloud REST API, and web clients must never drift. Every shape that crosses a process boundary is defined ONCE here as a zod schema; TS types come from `z.infer`. Depends on `@brainz/engine` for domain types; pure/Workers-safe like engine (zod is the only extra dep).

- **MCP tool registry**: `MCP_TOOLS` — an ordered record of all 8 tools, each `{ name, description, inputSchema (zod object), outputSchema (zod) }`. Tool descriptions (the orchestrator-facing UX text) live HERE, not in the server. `@brainz/mcp-server` must build its tool registrations by iterating this registry — no hand-declared names/schemas left in the server. The remote MCP in apps/cloud iterates the same registry.
- **Tool outputs**: the JSON payload of each tool response is validated against its `outputSchema` in tests (server tests parse response text with the contract schema — that's the sync guarantee).
- **REST API schemas**: request/response zod schemas for every apps/cloud endpoint (vault, concept, key create/list, search, related, context, graph `{nodes, edges}` incl. `pending` flag, stats). The SvelteKit UI's typed fetch client imports these.
- **CLI `--json` shapes**: reuse the same schemas (search hits, show, related, context bundle, validate report, reindex/stats). CLI tests assert `--json` output parses with the contract schema.
- Versioned lightly: export `CONTRACTS_VERSION` string; bump on breaking shape changes.

Refactor obligations when this package lands: mcp-server derives registrations from `MCP_TOOLS`; cli imports output types + validates in tests; packages/web may adopt the graph/concept schemas where trivial (don't force it). Existing behavior/wire shapes must NOT change — encode what's already shipped.

## `@brainz/engine` (extracted from core; core refactored to consume it — all existing tests stay green)

Exports (pure functions + shared types):
- All shared types from SPEC.md (`ConceptType`, `ConceptMeta`, `Concept`, `Edge`, `SearchHit`, `RelatedNode`, `ContextBundle`, …) — core re-exports them so downstream imports don't break.
- `slugify(s)`
- `parseNote(markdown, {fallbackId}) → { meta, body, wikiLinks, relations }` (wiki-link extraction excludes code fences/spans — move core's logic here verbatim)
- `serializeNote(meta, body) → markdown` (frontmatter round-trip, preserves unknown keys via a passthrough map)
- `rrfFuse(listA, listB, k=60) → ranked ids`
- `cosineSim(a: Float32Array, b: Float32Array) → number` (+ `packVector`/`unpackVector` blob helpers)
- `bfsRelated(edges: Edge[], startId, {depth, limit, relations}) → RelatedNode[]` (deterministic ordering: distance, then id — same semantics as core today)
- `assembleContext(seeds: {concept, score}[], expand: (id)=>Concept[], {depth, tokenBudget}) → ContextBundle` — or a data-in/data-out shape that both core (sync sqlite) and cloud (async D1) can drive; agent may adapt signature so both callers share the ranking/budget/truncation logic. THAT logic must live in engine exactly once.
- `validateGraph(concepts, edges) → {errors, warnings}` (dup ids, broken links)

No behavior changes to `@brainz/core`'s public API. Engine has zero runtime deps except possibly `gray-matter` — check gray-matter works on Workers (it should; it's pure JS + js-yaml). Vitest tests moved/added for every export.

## `apps/cloud` — SvelteKit on Cloudflare

Stack: Svelte 5 (runes), SvelteKit, `@sveltejs/adapter-cloudflare`, wrangler.jsonc bindings: `DB` (D1, control plane only), `VAULT_DO` (Durable Object namespace, `new_sqlite_classes` migration), `AI` (Workers AI). Drizzle ORM + drizzle-kit migrations for D1. Zod for input validation. Dark theme matching packages/web aesthetic.

### Wrangler setup (explicit deliverable — TICKET: wrangler-setup)

`apps/cloud/wrangler.jsonc`, complete and deploy-ready except account-specific ids:
- `name: "brainz-cloud"`, `main` per adapter-cloudflare output, `compatibility_date` (recent), `compatibility_flags: ["nodejs_compat"]` (required: gray-matter touches Buffer/fs-stubs — verified in the engine wave)
- Bindings: `DB` (d1_databases — `database_id: "<REPLACE>"` placeholder + comment with the `wrangler d1 create brainz` command), `VAULT_DO` (durable_objects binding to class `VaultDO` + `migrations: [{ tag: "v1", new_sqlite_classes: ["VaultDO"] }]`), `AI` (Workers AI)
- `routes: [{ pattern: "brainz.brownmatter.ai", custom_domain: true }]`
- Assets/static config as adapter-cloudflare requires; `.dev.vars.example` (BETTER_AUTH_SECRET, BETTER_AUTH_URL=http://localhost:5173, GITHUB_CLIENT_ID/SECRET optional); `.dev.vars` gitignored
- npm scripts: `dev` (vite dev with platformProxy), `build`, `preview` (wrangler dev on built output), `deploy` (build + wrangler deploy), `db:generate` (drizzle-kit), `db:migrate:local` / `db:migrate:remote` (wrangler d1 migrations apply)
- README-CLOUD deploy runbook (user-side, in order): wrangler login → `wrangler d1 create brainz` → paste id → `db:migrate:remote` → `wrangler secret put BETTER_AUTH_SECRET` (+ BETTER_AUTH_URL) → DNS for brownmatter.ai on the Cloudflare account → `npm run deploy` → verify `/mcp` with a bearer key
- Acceptance: `wrangler dev` boots locally with local D1 + DO; `wrangler deploy --dry-run` (or `wrangler versions upload --dry-run` equivalent) passes config validation without an account.

### Storage architecture: one Durable Object per vault

**Vault content lives in a per-vault Durable Object (`VaultDO`) using DO SQLite storage (`ctx.storage.sql`).** D1 is only the shared control plane. Isolation comes from the DO boundary, not WHERE clauses.

**D1 (control plane, drizzle):**
- Better Auth tables (user, session, account, verification) — generated per Better Auth docs
- `vault(id pk, owner_id → user, slug, name, created_at)` — slug unique per owner; `id` is the DO name → `env.VAULT_DO.idFromName(vault.id)`
- `api_key(id pk, vault_id → vault, name, key_hash, key_prefix, created_at, last_used_at)` — token format `bz_<32 rand>`; SHA-256 hash at rest; plaintext shown exactly once at creation
- Dreaming spend controls: `dream_spend` (per-user, per-UTC-day ledger), `llm_key` (one AES-GCM-encrypted BYOK dream key per user), `control_flag` (operator kill switch) — see "Spend controls" under Dreaming

**VaultDO SQLite (data plane, per vault):**
- `concept(id pk, title, type, status, product, tags_json, body, hash, created_at, updated_at)`
- `edge(from_id, to_id, relation, src)` where src = 'wiki' | 'frontmatter'
- `embedding(concept_id pk, vector blob, hash)`
- FTS5 virtual table for concepts if DO SQLite supports it (verify at runtime/in dev!); otherwise fall back to a LIKE/token-based keyword search — hybrid still works via engine's RRF.
- Schema created/migrated idempotently in the DO constructor (`blockConcurrencyWhile`) with a `meta(schema_version)` row.

VaultDO exposes typed methods (RPC-style via DO class methods, or a fetch router — agent's call; RPC preferred on modern wrangler): `upsertConcept`, `deleteConcept`, `getConcept`, `list`, `search`, `related`, `graph`, `context`, `stats`, `destroy` (called on vault delete: `deleteAll` storage). All graph/search/context logic comes from `@brainz/engine`; the DO is storage + orchestration only.

Concept writes parse the submitted markdown body with engine's `parseNote` (wiki-links → edge rows, relations → edge rows) and re-embed via Workers AI (`@cf/baai/bge-base-en-v1.5`, 768-dim) when hash changes — the Worker passes an embed callback/result into the DO or the DO calls `env.AI` directly (bindings are available to DOs). If AI is unavailable (local dev without login, tests), degrade to keyword-only — mirror core's graceful fallback. Embedding failures must never fail the write.

### Auth (Better Auth)

- better-auth with drizzle adapter (sqlite/D1), email+password enabled; GitHub OAuth enabled only when `GITHUB_CLIENT_ID/SECRET` present.
- SvelteKit integration per Better Auth docs: mount handler in `src/hooks.server.ts`, expose session in `locals`. Client: better-auth/svelte client for the UI.
- **Production domain: `https://brainz.brownmatter.ai`** — the user-facing dashboard AND the MCP/API host. `BETTER_AUTH_URL=https://brainz.brownmatter.ai` in production (localhost in `.dev.vars`), Better Auth `trustedOrigins` includes it, and wrangler.jsonc declares the custom domain route (`routes: [{ pattern: "brainz.brownmatter.ai", custom_domain: true }]`). MCP setup snippets/docs use `https://brainz.brownmatter.ai/mcp`.
- Secrets via wrangler: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`. Provide `.dev.vars.example`.
- API keys: either Better Auth's apiKey plugin or the custom `api_key` table above — agent's call, but requirements hold: per-vault scope, hashed at rest, shown once, revocable from UI, `last_used_at` updated on use.

### REST API (`src/routes/api/**` — session cookie OR bearer key; bearer is scoped to its vault only)

- `GET/POST /api/vaults`, `GET/PATCH/DELETE /api/vaults/:vaultId`
- `GET/POST /api/vaults/:vaultId/concepts`, `GET/PUT/DELETE .../concepts/:id`
- `GET .../search?q=&mode=&type=&product=&limit=`
- `GET .../related/:id?depth=&limit=`
- `POST .../context` `{query?, ids?, depth?, tokenBudget?}` → ContextBundle
- `GET .../graph` → nodes+edges (pending nodes flagged, same shape as packages/web /api/graph)
- `GET/POST /api/vaults/:vaultId/keys`, `DELETE /api/keys/:keyId` (session only — keys can't mint keys)
- `POST .../import` (multipart of .md files) and `GET .../export` (zip or concatenated markdown) — nice-to-have, skip if time
- JSON errors `{error}`, proper status codes, zod-validated bodies. Never leak other users' vaults (every query filters by owner/vault binding).

### Remote MCP (`/mcp` route)

- MCP Streamable HTTP, auth: `Authorization: Bearer bz_...` → resolves vault via D1 key lookup, then routes into that vault's `VaultDO`; 401 otherwise.
- Same 8 tools as SPEC.md (search_concepts, get_concept, get_related, get_context, upsert_concept, link_concepts, list_concepts, vault_stats), registered by iterating `MCP_TOOLS` from `@brainz/contracts`, backed by the VaultDO + engine.
- Implementation options (agent's call, in preference order): (a) Cloudflare `agents` SDK `McpAgent` — MCP server AS a Durable Object, the platform-native pattern; run it per-vault, or (b) stateless `@modelcontextprotocol/sdk` StreamableHTTP via a fetch-adapter (e.g. `@hono/mcp`) in the route handler that calls into VaultDO. Either way the agent verifies against a real MCP client call over HTTP in wrangler dev. If McpAgent fights SvelteKit route integration, (b) is fine — don't sink hours.
- Client wiring docs: `claude mcp add --transport http brainz https://<host>/mcp --header "Authorization: Bearer bz_..."` (and raw .mcp.json equivalent).
- **Discovery / advertisement (standards)**: the server is auto-discoverable — `static/.well-known/mcp.json` (and the SEP-1649 alias `static/.well-known/mcp/server-card.json`) serve a server-card document in the MCP Registry `server.json` schema (name `ai.brownmatter/brainz`, streamable-http remote at the production `/mcp`, `Authorization` header advertised as optional+secret since unauthenticated connections get the public toolset) plus a namespaced `_meta` block listing both toolsets, the signup/claim flow one-liner, and the `/skill.md` prompt URL. A registry publish artifact `apps/cloud/server.json` (same doc minus `_meta`; description ≤ 100 chars per registry cap) is published to registry.modelcontextprotocol.io under the DNS-verified `ai.brownmatter/*` namespace — runbook in apps/cloud/README.md. `discovery.test.ts` pins all three artifacts to the contracts registries (tool lists, SERVER_VERSION, production URL) so they cannot drift.
- **Grok Build plugin**: `integrations/grok-build/brainz/` is the source of truth for `external_plugins/brainz` in `xai-org/plugin-marketplace` (vendored local plugin: `.grok-plugin/plugin.json`, a `.mcp.json` pointing at the production `/mcp` with `Authorization: Bearer ${BRAINZ_API_KEY}`, and a `brainz` skill). The key comes from the user's environment; no key is bundled, and an unset variable reads as an invalid bearer (401). The skill stays task-triggered (no "every session" steering) and never asks for the key in chat. Update flow: copy the folder into the marketplace fork, regenerate its index, PR.
- **Human-facing instructions**: the app splash (`/`) shows the endpoint + `claude mcp add` snippet and links `/.well-known/mcp.json`, `/skill`, and the marketing docs; the marketing `/docs` page keeps the full hosted + local wiring guide.

### Agent-driven signup over MCP (public toolset)

An orchestrator agent must be able to provision a workspace straight from the MCP endpoint — **without an email** — and the workspace only becomes permanent once a human approves attaching their email (see Wave G below, which supersedes this section's earlier email-at-signup + `claimUrl`/`loginUrl` designs):

- **Unauthenticated `/mcp` connections** no longer 401: they get a PUBLIC MCP server exposing exactly one tool, `signup` `{vaultName?, email?}`. (Invalid/revoked bearer still 401s — only *absent* auth gets the public server.)
- `signup` creates a **provisional** account: a Better Auth user row with a placeholder identity (`unclaimed-<userId>@pending.brainz.invalid`, `emailVerified: false`, `expires_at = now + 7 days`), a first vault (default "My vault"), and an API key. Returns `{ apiKey: "bz_…", vaultSlug, expiresAt, claimEmailSent }` — NO login or claim URL is ever returned to the agent (a returned URL sits in orchestrator logs and proves nothing about a human).
- If `email` is supplied, it is NOT bound to the account — it merely triggers the same claim-request flow as the `claim` tool (Wave G), and `claimEmailSent: true` is returned regardless of the address's eligibility (no account-existence oracle).
- **Rate limiting**: per-IP (CF-Connecting-IP) counter, max 5 signups/hour — D1 `signup_events`; 429-style isError beyond it.
- Provisional accounts EXPIRE unclaimed: bearer auth (REST + MCP) rejects keys whose owner is past `expires_at` with a clear "workspace expired unclaimed — sign up again" message. Persistence requires the Wave G claim flow.
- Contract: the `signup` tool schema lives in `@brainz/contracts` as `PUBLIC_MCP_TOOLS` (same shape as MCP_TOOLS; NOT added to the vault tools — the local stdio server has no accounts). Docs (app MCP snippets + the self-onboard skill, Wave G) mention the flow.

### Onboarding (`onboard` tool + CLI command)

A vault must be onboarded before it's genuinely useful: onboarding = an orchestrator agent indexing an existing product's codebase into the vault. Brainz doesn't run agents itself — the `onboard` tool hands the CALLING agent a structured playbook and tracks completion.

- **The product ontology** (types grow to 10: add `domain`, `workflow`, `story`, `spec` — engine + contracts + core + DO + both UIs' palettes + docs):
  - `domain` — high-level product area ("Authentication", "Search"). The top of the graph; everything else hangs off domains.
  - `feature` — a concrete capability, `part_of` a domain.
  - `story` — a user story; the MAPPING facet between domains and features: story is `part_of` its domain and `realized_by` one or more features ("As a user I stay signed in across visits" → part_of Authentication, realized_by Session Refresh).
  - `spec` — technical specification: the RULES under which a function must be performed; a spec `governs` the features/stories/domains it constrains (e.g. "Session tokens rotate every 15 min" governs Session Refresh).
  - `workflow` — a multi-step user/system journey across features (`part_of` domain, `depends_on`/references features in order).
  - `concept` (generic), `decision`, `constraint`, `pattern`, `glossary` — as before.
  - Canonical relations grow: `realized_by`, `governs` join `depends_on`, `part_of`, `constrains`, `supersedes`, `related_to` (relations stay free-form strings; these are the documented conventions the playbook teaches).
- **Code areas**: optional frontmatter `code_areas: ["packages/core/src/vault.ts", "apps/cloud/src/routes/api/**"]` — rough paths/globs telling a coding agent where in the codebase this knowledge lives. Additive `codeAreas?: string[]` on ConceptMeta (engine + contracts schemas + upsert inputs incl. MCP/REST/CLI). `get_context` bundles append a `Code areas:` line to each section that has them — that's the payoff: a subagent briefed by get_context knows both the rules AND where to apply them. UIs show them as monospace chips in the concept panel.
- **Vault state**: `onboarded_at` (nullable) on the vault (D1 control-plane column) and mirrored in VaultDO meta; exposed in `vault_stats` / stats endpoints as `onboarded: boolean`.
- **MCP tool `onboard`** (authenticated surface, 9th tool; also in MCP_TOOLS for the local stdio server with core storing onboarded state in vault config):
  - `{action: "start", productName?, repoHint?}` → returns the PLAYBOOK (markdown): instructions to fan out subagents over the codebase (exclude node_modules/dist/.git/lockfiles/binaries), inventory every app file, and distill NOT file-by-file notes but product knowledge structured by the ontology: identify the domains first, then per domain the features (`part_of`), stories mapping to the features that realize them (`realized_by`), specs stating the rules that `govern` them, workflows, decisions, constraints, glossary — every concept carrying `code_areas` pointing at the rough parts of the codebase it lives in; each as `upsert_concept` calls with wiki-links/relations; target 20–60 concepts for a mid-size product; finish by calling `{action:"complete", summary}`.
  - `{action: "complete", summary}` → sets onboarded, stores summary as a `spec`-type concept `product-onboarding-summary`.
  - `{action: "status"}` → {onboarded, conceptCount, byType}.
- **Nudge, not a wall**: while un-onboarded, `get_context` and `search_concepts` responses are prefixed with a one-line notice ("vault not onboarded — call onboard to index your product first"). No hard blocking.
- **CLI**: `brainz onboard [--status|--complete]` — same playbook/semantics for local vaults (state in brainz.config.json).
- Docs: dashboard MCP snippets mention onboarding as step 1; marketing /docs gets a subsection.

### Tasks & drift sync (the work loop)

Brownmatter is not just a map of the product — it's the pile of work on it, and it must stay true to the artifact (the codebase). Two capabilities:

**Tasks — "take a task off the pile" (Wave T — build & deploy FIRST, before working any backlog):**
- New concept type `task` (11th) — added to ConceptType in engine + contracts (`conceptTypeSchema`, `CONCEPT_TYPES`) + core + VaultDO + both MCP servers + CLI + both graph UI palettes + docs, exactly as the earlier 4 types were added. A task is a unit of work not yet reflected in the artifact.
- Task frontmatter fields (additive to ConceptMeta, all optional): `taskStatus: "open" | "taken" | "done"` (distinct from concept `status`; default `open` for `task`-type concepts), `takenBy?: string` (free-form agent/orchestrator label), `takenAt?: string` (ISO), `doneAt?: string`. Threaded through engine parse/serialize (`task_status`/`taken_by`/`taken_at`/`done_at` frontmatter), contracts schemas (bump CONTRACTS_VERSION), core, VaultDO SQLite columns (gated additive migration), REST, MCP upsert input, CLI. Relations: a task `realizes` stories/features, `governed_by` specs, `part_of` a domain; `code_areas` say where the work lands.
- MCP tools (authenticated surface — added to MCP_TOOLS registry, both servers iterate): `list_tasks {taskStatus?, domain?}` → tasks with their status/taken fields, oldest-first; `take_task {id?}` → claims a specific task or THE NEXT open one (deterministic: oldest `open` by createdAt then id), sets taskStatus=taken + takenBy + takenAt ATOMICALLY (DO storage is single-threaded so read-modify-write is safe; reject if already taken), and returns the task PLUS an auto-assembled `get_context`-grade bundle for its `part_of` domain + related concepts (code areas included) so the caller can fan out immediately; `complete_task {id, outcome}` → sets taskStatus=done + doneAt, appends `outcome` to the task body, and the result REMINDS the caller to index what changed via upsert_concept so the graph stays true to the artifact.
- The orchestrator contract (in take_task's description + playbook): after implementing, verify the artifact matches every spec that `governs` the task; discrepancies → fix or file a new task; then index the new/changed knowledge.
- `create_task {title, body, domain?, realizes?, governedBy?, codeAreas?}` convenience tool (or via upsert_concept with type task) so findings become first-class tasks. The five current concept-tagged tickets (`task-*`, tag `task-open`) MIGRATE to real `task`-type concepts with `taskStatus:"open"` as part of this wave.

**Real-time Kanban board (part of Wave T):**
- New app route `/v/[slug]/board` (linked from the vault workspace + dashboard): a Kanban with columns **Open · Taken · Done** driven by the vault's `task`-type concepts.
- **Grouping (switchable)**: by status (default columns), by **related concept** (swimlanes per `part_of` domain / the concept a task `realizes`), by priority tag, or by `takenBy`. A group-by control in the board header re-lays out lanes/columns live.
- **Cards** show title, priority/area tags, `takenBy` when taken, and the code_areas count; clicking a card opens the existing concept panel (rendered markdown + edges) so the board and graph share one detail view. Cards link to the concepts the task `realizes`/`is governed_by` (click-through to the graph neighborhood).
- **Real-time**: the board reflects task changes without a manual refresh. Implement via short-interval polling of `GET /v/:id/tasks` (e.g. 3–5s) with diff-and-animate, OR SSE from the Worker if trivial — polling is the acceptable default (VaultDO has no push). Moving a card between columns issues the corresponding `take_task`/`complete_task`/reopen mutation (session-auth) and optimistically updates. An agent taking a task over MCP shows up on the board within one poll — the human watches the fleet work.
- REST: `GET /api/vaults/:id/tasks {taskStatus?,domain?,groupBy?}`, and card moves reuse task mutations. Dashboard vault cards get an open-task count chip; stats expose `openTasks`. Obsidian-dark styling; `task` nodes get their own palette color + open/taken/done badge in the graph view too.

**Drift sync — keep brownmatter true to the artifact:**
- `sync` MCP tool (+ `brainz sync` CLI): `{action: "start"}` → returns a SYNC PLAYBOOK: the vault's `last_synced_at` (+ onboarded state), all concepts' code_areas as a coverage map, and instructions: diff the codebase since last sync (git log/status since timestamp), fan out subagents over changed areas, update stale concepts, index un-mapped new work (features/stories/specs/tasks for incomplete work found), report coverage gaps (code areas no concept references). `{action: "complete", summary}` → sets `last_synced_at`, stores summary in the `product-onboarding-summary` concept (append log).
- Staleness nudge: `get_context` prefixes a one-liner when last_synced_at is older than 14 days ("knowledge may be stale — run sync"), same style as the onboarding nudge.
- Stats expose `openTasks`, `lastSyncedAt` (UI: task count chip on dashboard cards; tasks filterable in the workspace, `task` gets its own palette color + open/taken/done badge).

### Session defaults — agents use Brainz every session (`session_hook` tool + server instructions)

**Problem:** connecting the MCP server gives an agent the tools but no reason to reach for them; a fresh session only uses Brainz if a human says so. Fix, in two layers, both rendered from `packages/engine/src/session.ts` (one voice, like the onboarding playbook):

- **Server `instructions` (zero install):** both MCP servers (local stdio + cloud `/mcp`) return `sessionInstructions()` as the MCP `instructions` on initialize — a short primer: `get_context` before planning or delegating, `list_tasks`/`take_task`/`complete_task` for work, `upsert_concept`/`create_task` to write back, `onboard`/`sync` when nudged. A viewer-scoped public-vault connection gets the read-only variant (no write/task tools named, since they aren't registered). The unauthenticated signup surface is unchanged.
- **MCP tool `session_hook`** (in MCP_TOOLS, so local + cloud authenticated surfaces; NOT in the public read set): `{client?: "claude-code" | "other", serverName?}` → ONE markdown text block, the SESSION-HOOK PLAYBOOK (same convention as `onboard`/`sync` start; no JSON form). Brainz can't write to the caller's repo, so the playbook instructs the CALLING agent to install the primer in its own harness:
  - **Claude Code:** write the primer to `.claude/brainz-session.md` and merge a `SessionStart` hook (`cat .claude/brainz-session.md`, no matcher → fires on startup, resume, clear, and compact) into `.claude/settings.json`, preserving existing keys and hooks.
  - **Other clients:** add the primer to `AGENTS.md` (or the client's rules file) between `<!-- brainz:session:start -->` / `<!-- brainz:session:end -->` markers.
  - Idempotent: re-running replaces the primer / marked block, never duplicates. Stateless on the Brainz side — nothing is recorded in the vault.
- **CLI:** `brainz hook [--client] [--server-name]` prints the same playbook (no vault required — the hook lives in the code repo); `brainz hook --install [--dir <repo>]` performs the Claude Code install itself (refuses to touch an unparseable `settings.json`).
- Docs: skill.md gains the install step after onboarding; discovery documents list the tool.

### Dreaming — autonomous nightly vault consolidation (`dream` tool + DO alarm)

**Problem:** the graph only improves when an agent remembers to `sync`. Duplicates pile up, knowledge that only lives in a finished task's `## Outcome` never becomes a concept, and contradictions sit unnoticed. Dreaming is **fully autonomous** background consolidation (user decision 2026-10-27): the server does the thinking and applies the changes itself, no agent in the loop — bounded by hard safety rails and fully revertible. Ideas (not code) from OpenClaw's memory-core dreaming: light → REM → deep phases plus a Dream Diary.

**Where the logic lives.** Everything deterministic is pure engine code in `packages/engine/src/dream.ts` (Workers-safe): candidate detection, the REM prompt + response parser, threshold gates, the loss rail, plan building (the exact after-state of every touched concept), the resumable sweep state machine, and diary rendering. Hosts (VaultDO in cloud, `Vault` in core) only snapshot their data, call the LLM through a provider seam, persist checkpoints, apply the plan and keep preimages.

**A sweep** (one "dream") runs three phases in order over the vault's concepts (`task`-type concepts are inputs, never merge candidates; the `product-onboarding-summary` concept is never touched):

- **Light** (no durable write) — stages what changed since the previous sweep (`updatedAt > lastDreamAt`; everything on the first sweep):
  - *duplicate candidates*: pairs of non-task concepts, at least one of them changed, scored by embedding cosine when both have vectors (`≥ 0.92`), else lexical similarity (same `slugify(title)` ⇒ 1.0, else Jaccard over title+body word tokens `≥ 0.8`). Work is chunked: each step compares at most `lightBatch` (200) changed concepts against the vault.
  - *outcome candidates*: `done` tasks with a `## Outcome` section, done since the previous sweep, that no concept is yet `derived_from`.
  - *hygiene counts*: orphans (no edges either way), pending wiki-links (targets with no concept), concepts lacking `codeAreas`. Counted for the diary only.
- **REM** (no durable write) — an LLM pass over the staged material in chunks (≤ 6 duplicate pairs + ≤ 4 outcomes + changed concept titles per call, at most `maxLlmCallsPerStep` (3) calls per step). The model returns JSON *proposals*, never prose to splice in: `merges [{keep, drop, confidence}]`, `promotions [{task, title, type, body, confidence}]`, `links [{from, to, relation, confidence}]`, `contradictions [{ids, summary, confidence}]`, `themes [string]`. Malformed output is dropped (counted as `unparseable`), never retried in a loop.
- **Deep** (the only durable write) — gates every proposal, builds the plan, checks the loss rail, applies:
  - *merge* — only for a pair Light staged (the model cannot invent merges), confidence `≥ 0.8`. Survivor `keep` absorbs the other: tags / codeAreas / relations unioned, `drop`'s body appended under `## Merged from <title> (<id>)` unless already contained. Every concept that referenced `drop` (relation targets or `[[drop]]` / `[[drop|label]]` wiki-links) is rewritten to point at `keep` — edges redirect. `drop` is **tombstoned**: removed from the live graph, its full prior state kept in the dream's preimage log.
  - *promote* — outcome of a staged task, confidence `≥ 0.7`, type in `feature | decision | constraint | spec | pattern | glossary | concept`, id (`slugify(title)`) not already taken. Creates the concept with `relations.derived_from: [task]`, tag `dreamed`, and a provenance line.
  - *link* — both ends exist, not already linked with that relation, confidence `≥ 0.7`; appended to the source concept's relations.
  - *contradiction* — confidence `≥ 0.6` ⇒ files an open `task` (`tags: [dream, contradiction]`, `related_to` both concepts) for a human/agent. Dreaming never silently picks a side.
  - Per-sweep caps: `maxMerges` 5, `maxPromotions` 5, `maxLinks` 10, `maxContradictions` 3. Over-cap proposals are rejected with reason `cap`.
  - **Loss rail**: `touched` = existing concepts the plan would remove or modify. If `touched > max(minTouchAllowance (3), floor(maxTouchFraction (0.2) × priorConceptCount))` the WHOLE deep phase is rejected (`rejected: loss-threshold`) and nothing is written. Additions (new concepts, new tasks) don't count.
  - Rejections are reported as counts by reason (`below-threshold`, `not-staged`, `exists`, `missing`, `bad-type`, `cap`, `unparseable`), never by dumping snippets.

**No LLM ⇒ light only.** If no provider is available (no `AI` binding — e.g. `wrangler.dev.jsonc`, tests, local without a provider), REM and deep are `skipped` with a reason and the sweep still writes a diary entry. Same spirit as the embeddings fallback: never crash, always leave a visible trace. LLM failures mid-REM mark REM `skipped` (`llm-error`) and skip deep.

**LLM provider seam** — `DreamLlm { name; complete({system, user, maxTokens}) → Promise<string> }`. Cloud default: Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via `env.AI` (no key to manage); a user's own key (BYOK, below) swaps in an Anthropic or OpenAI-compatible provider without touching the engine. Local (`@brainz/core`): `Vault.dream({llm})` takes an injected provider; the CLI ships none yet, so `brainz dream run` locally does light + diary.

**Spend controls (cloud; user decision 2026-10-28 — required before Dreaming is deployed).** REM is the only part of a dream that costs money. Three controls decide, before EVERY REM step, which provider (if any) the step may use. The decision lives in `apps/cloud/src/lib/server/dream-budget.ts` (pure helpers over a D1 handle); the VaultDO reads the D1 control plane through its own `DB` binding.

- **Account = the Brainz user who owns the vault** (`vault.owner_id`). The VaultDO learns its vault id from the `x-brainz-vault-id` header every Worker → DO call carries (stored in DO meta `vault_id`; `ctx.id.name` as a fallback) and resolves the owner in D1. Unknown owner or no `DB` binding ⇒ no operator-paid REM (fail closed).
- **Selection order** (first match wins): (1) kill switch `all` ⇒ REM skipped, reason `disabled: …`; (2) the owner has a stored key ⇒ REM runs on it (`byok:anthropic` | `byok:openai`), outside the cap; (3) kill switch `workers-ai` ⇒ skipped, `disabled: …`; (4) no `AI` binding ⇒ skipped, `no LLM provider available`; (5) the owner's spend today ≥ cap ⇒ skipped, `budget: …`; (6) Workers AI, metered.
- **Daily cap per account.** Default `DREAM_DAILY_USD_PER_ACCOUNT = 1` (USD, a wrangler `var`, raise it without code changes). It covers all of the owner's vaults combined, per UTC day. Each Workers AI dream call is metered in USD from the `usage` the binding returns (`prompt_tokens` / `completion_tokens`), falling back to a chars/4 estimate of prompt and completion, priced with `DREAM_LLM_PRICE_USD_PER_M` (the published Workers AI price for the model, input/output per M tokens, beside `DREAM_LLM_MODEL`). The DO checks the remaining budget before each REM step and adds the step's spend to the ledger after it, so a step can overshoot the cap by at most one step (≤ `maxLlmCallsPerStep` calls). BYOK calls are never metered.
- **Global kill switch.** D1 `control_flag` row `dreaming_kill_switch` (`off` | `workers-ai` | `all`; flipped with `wrangler d1 execute`, no redeploy — exact command in apps/cloud/README.md), overridable by the wrangler var `DREAMING_AI_DISABLED` (`1`/`true`/`workers-ai` or `all`). The stronger of the two wins. `workers-ai` stops every operator-paid call (BYOK users keep dreaming on their own key); `all` stops every dream LLM call. Light still runs either way.
- **Bring your own key.** A user stores ONE dream LLM key on their account: `anthropic` (API key, optional model, default `claude-opus-5-5` at `effort: "low"`) or `openai` (any OpenAI-compatible endpoint: https base URL + key + model, `POST {baseUrl}/chat/completions`). Encrypted at rest in D1 with AES-GCM (256-bit key = SHA-256 of the `BYOK_ENCRYPTION_KEY` secret, random 12-byte IV, the user id as additional data). The plaintext is never returned after saving — only a hint (first 7 characters + `…` + last 4). A key that is invalid, fails, or can't be decrypted makes REM `llm-error` — dreams NEVER fall back to Workers AI.
- **Skipped REM keeps its material.** When REM is skipped for `budget` or `disabled`, the sweep still finishes light-only with a diary entry naming the reason, and the vault remembers the sweep's `since` (DO meta `dream_backlog_since`), so the next sweep (the next day's alarm) re-stages the same material and retries REM. The backlog clears once a sweep's REM runs. Never fails the sweep.

**Preimages & revert.** Before applying, the host records a preimage per touched concept (cloud: the full DO row; local: the raw markdown file + path; `null` for created concepts) and the after-state's `updatedAt`. `dream {action:"revert", id}` restores every preimage (deletes created concepts, restores modified/tombstoned ones byte-for-byte, rebuilding edges/FTS) — the vault returns to its exact pre-dream state. Revert **refuses** (listing conflicts) when any touched concept changed after the dream (its current `updatedAt` ≠ recorded after-state or it was deleted/created since), so later agent work is never clobbered. A dream can be reverted once; the diary entry is marked `reverted`.

**Dream Diary.** One entry per sweep that found material: `{id, startedAt, finishedAt, trigger: "alarm"|"manual", status: "applied"|"nothing-applied"|"rejected"|"light-only"|"reverted", phases: {light, rem, deep}, applied: [{kind, id, summary}], rejected: {reason: count}, themes, markdown}`. Counts and ids, not dumps. An empty sweep (nothing changed since the last one) records `lastDreamAt` and writes no entry.

**Storage.**
- Cloud (VaultDO, schema v7, additive): table `dream(id TEXT PK, started_at, finished_at, trigger, status, diary_json, preimage_json, reverted_at)`; meta keys `dream_enabled` (default on), `dream_cadence_hours` (default 24, 1–168), `last_dream_at`, `dream_checkpoint` (JSON sweep state while a sweep is in flight), `vault_id` (the DO's vault, for spend attribution), `dream_backlog_since` (set while REM is owed after a `budget`/`disabled` skip; `*` = since the beginning).
- Cloud (D1 control plane): `dream_spend(user_id, day, usd_micros, calls, updated_at)` PK `(user_id, day)` — the per-account daily ledger (`day` = UTC `YYYY-MM-DD`, integer micro-dollars); `llm_key(user_id PK, provider, ciphertext, iv, key_hint, base_url, model, created_at, updated_at)` — one BYOK key per user, AES-GCM ciphertext; `control_flag(key PK, value, updated_at)` — operator flags (`dreaming_kill_switch`). Diary retention: newest 50 entries (older rows pruned with their preimages).
- Local: `<vault>/.dreams/<id>.json` (diary + preimages) and `lastDreamAt` in `brainz.config.json`. NOT under `.brainz/` — preimages are not derivable state.

**Scheduling (cloud).** The VaultDO schedules its own DO alarm: on construction, if dreaming is enabled and no alarm is set, it sets one `cadence` hours after the last dream (or from now). `alarm()` advances the in-flight sweep by ONE bounded step (`lightBatch` comparisons, ≤ `maxLlmCallsPerStep` LLM calls; deep applies in one step since touched is bounded by the rail) and persists the checkpoint; if the sweep isn't finished it re-arms the alarm for +1s, else for the next cadence. That keeps every invocation inside the Workers CPU-time and subrequest budget. Embeddings for concepts a dream writes are recomputed (≤ the touched bound). `destroy` deletes the alarm. Disabling dreaming clears the alarm and any in-flight checkpoint.

**Surfaces.**
- MCP tool `dream` in `MCP_TOOLS` (authenticated surfaces, cloud + local stdio; not in the public read set): `{action: "status"}` → `{enabled, cadenceHours, lastDreamAt, nextDreamAt, inFlight, llm, lastEntry?, provider?, killSwitch?, spend?}` (cloud adds `provider: "workers-ai" | "byok:<provider>" | null` — what the next REM step would use, `killSwitch: "off"|"workers-ai"|"all"`, and `spend: {day, usd, capUsd, remainingUsd}` for the vault owner today); `{action: "run"}` → starts (or continues) a sweep and advances it as far as one request allows, returns `{status: "done"|"in-progress", entry?}`; `{action: "diary", limit?}` → recent entries (newest first); `{action: "revert", id}` → `{reverted, restored, conflicts?}`; `{action: "configure", enabled?, cadenceHours?}` → status. CONTRACTS_VERSION 15 (16: spend-control status fields + account dreaming REST shapes).
- REST (session only, the caller's own account): `GET /api/account/dreaming` → `{provider, key: {provider, hint, baseUrl, model, updatedAt} | null, spend: {day, usd, capUsd, remainingUsd}, killSwitch}`; `PUT /api/account/llm-key` `{provider: "anthropic"|"openai", apiKey, baseUrl?, model?}` → the same shape (set or replace); `DELETE /api/account/llm-key` → the same shape. Shapes in `@brainz/contracts` `api.ts`.
- UI: `/v/[slug]/settings` gains a "Dreaming" card (every member — it is about the signed-in user's own account): set/replace/remove the key, and "today's dream spend / cap" while no key is set.
- `vault_stats` gains optional `lastDreamAt`.
- CLI: `brainz dream [status|run|diary|revert <id>]` over a local vault (`--json` uses the same contract shapes).
- Docs: skill.md, discovery documents, marketing `/docs` tool count.

### Projects, membership & tenancy (Wave P)

The tenant unit becomes the **project** — human-readable name, many users ↔ many projects, one knowledge vault (VaultDO) per project.

- **Schema** (prefixed ids per the ID convention): `project(id pj_…, name, slug, onboarded_at, created_at)`; `project_member(id mbr_…, project_id, user_id, role: owner|member, created_at)` — unique (project_id, user_id); existing `vault` table MIGRATES to project (rename/backfill: each vault becomes a project, owner becomes an owner-member; `vault.id` remains the DO name → store as `project.id` or keep a do_name column — agent's call, DO data untouched). `api_key` gains `created_by` (user id) and optional `expires_at` (lease); keys are project-scoped. `invite(id inv_…, project_id, email, role, token_hash, invited_by, expires_at +14d, accepted_at)`.
- **Auth leases**: API keys support optional expiry (`expires_at`; expired ⇒ same 401 as revoked). Default: non-expiring (revocable). UI + REST accept an expiry on creation; MCP signup-minted key stays non-expiring. Every key row records `created_by`; settings UI shows who minted each key. Keys can never mint keys or manage members (session-only, as today).
- **Strict tenancy**: every REST/MCP access resolves key/session → project → membership check (for sessions) before touching the DO; no cross-project reads of any kind; 404 (not 403) for non-member access, as today for foreign vaults. Tests must include explicit cross-tenant probes (member of A probing B via REST, MCP, and invite endpoints).
- **Invites**: owner/members can invite colleagues by email — creates an invite with a single-use hashed token; UI shows a shareable invite URL (`/invite/<token>`, same no-email-infra pattern as claim links). Acceptor signs in (or signs up/claims first) with the SAME email the invite names, then becomes a member. Expired/used/wrong-email → clear error. Members can leave; owners can remove members and revoke invites; last owner can't leave/demote.
- **Onboarding once per project**: `onboard {action:"start"}` on an onboarded project returns isError guidance ("already onboarded on <date> — use sync to update knowledge"); `complete` is idempotent-safe. (Sync, from Wave O2, is the repeatable path.)
- **Embedding rate limit**: per-project cap of 1000 embedding-model calls per rolling hour (counter in DO meta or D1 `embed_events` — cheap, index-friendly). Beyond cap: skip embedding, record `embeddingStatus`-style state `"rate-limited"` surfaced in stats; writes/search NEVER fail (keyword-only degradation, consistent with existing philosophy). Counter covers reindex embeds + semantic-search query embeds.
- **UI**: project picker in the (app) header (current project name + dropdown: switch, create, invite chip showing pending count); dashboard groups by membership; settings gains Members (list, roles, remove) + Invites (create w/ role, copy URL, revoke) sections; rename stays; create-project flow asks for a human-readable name (slug auto).
- **Contracts**: project/member/invite schemas + updated key schemas in api.ts; CONTRACTS_VERSION bump. REST routes move to `/api/projects/...` with `/api/vaults` kept as deprecated aliases until the UI/e2e migrate (delete aliases in the same wave if all callers are updated — preferred).

### User-definable concept types + per-vault type registry (Wave TR)

Make concept types **data, not a hardcoded enum** — per-vault, user-definable, weighted, editable in the UI. Defaults reproduce today's 11 types + behavior EXACTLY.

- **Type registry (per-vault):** a `concept_type` registry in the VaultDO (id/key, label, color, weight, order/hidden). On vault create it's SEEDED with the 11 built-in types (concept, domain, feature, story, spec, workflow, decision, constraint, pattern, glossary, task) with their CURRENT colors + a signal `weight` matching today's LOD ranking (domain highest → … → glossary/concept/task lowest). So a fresh vault behaves identically to now.
- **Users can:** add a custom type (key + label + color + weight), rename/recolor/re-weight/reorder/hide any type (including built-ins), via a settings UI panel. Deleting/hiding a built-in that concepts still use → reassign-or-block (don't orphan; simplest: hide, don't hard-delete if in use).
- **Wire safety (critical):** concept `type` stops being a strict zod enum and becomes a **validated string that must resolve to a key in the vault's type registry**; an unknown/removed type FALLS BACK to `concept` (matching the existing unknown-type behavior). Engine/contracts: replace the `ConceptType` union's enforcement at the boundary with registry validation; keep the 11 keys as the documented defaults + the ontology the onboarding playbook teaches. Do NOT break: onboarding playbook (still teaches the default ontology), computeCoverage, tenancy, existing concepts.
- **Weight drives everything from ONE source:** the per-vault type weights feed the semantic zoom-LOD tiers (`typesVisibleAtZoom` reads registry weights, not a hardcoded ranking), node sizing, and the default-visible-type set. Re-weighting a type in the UI immediately changes where it appears in the zoom progression + its size.
- **Contracts/REST:** type-registry schemas + CRUD endpoints (`GET/POST/PATCH/DELETE /api/vaults/:id/types`, owner/editor-gated per the role model); graph/concept responses carry the resolved type meta (color/weight) so the UI renders custom types. CONTRACTS_VERSION bump. MCP: `upsert_concept` accepts any registry type; a `list_types`/`define_type` tool is optional (note if deferred).
- **UI:** vault settings gains a "Concept types" panel (list built-in + custom, edit label/color/weight/order/hide, add custom); the graph palette + type-filter chips + zoom-LOD + sizing all read the registry. Obsidian-dark.
- **Sequencing:** builds ON TOP of the semantic-zoom-LOD work (the LOD signal ranking becomes registry weights) — do NOT build in parallel with it.

### Onboarding at scale — coverage-driven continue/status loop (Wave O-scale)

**Problem:** the onboarding playbook says "target 20–60 concepts," so agents stop at ~40 even on a 500+ concept codebase — they obey a flat cap that's wrong for large repos. Fix: make onboarding size-aware, resumable, and coverage-gated so it indexes the WHOLE project.

- **No flat cap.** The playbook stops prescribing 20–60. Instead it tells the agent to size the effort from the codebase (list packages/apps/major dirs; budget concepts per area; large repos → hundreds of concepts) and index **each area to saturation** before moving on. Depth guidance is per-area, not global.
- **`onboard {action:"status"}` becomes a COVERAGE REPORT** (not just counts): given the vault's concepts' `code_areas`, compute which top-level source areas (packages/*, apps/*/src subtrees, major dirs) are UNCOVERED (no concept references any file under them) vs covered, plus conceptCount and byType. The agent calls status to see what's left. Optionally accept `{codeAreasSeen?: string[]}` so the agent can report the areas it has surveyed and status diffs against the real tree (agent supplies the file list from its own repo walk, since the DO can't read the repo).
- **The continue loop (documented in the playbook):** survey → for each area: index to saturation via upsert_concept → call `onboard {action:"status"}` → if uncovered areas remain, keep going (take the next area) → repeat until coverage is broad. This is the agent's loop; Brainz provides the coverage signal each iteration so a fan-out agent doesn't stop early.
- **`onboard {action:"complete"}` is coverage-gated:** reject completion (isError with the list of uncovered areas) when coverage is thin — i.e. a large fraction of the reported source areas have zero concepts. The caller must pass the repo's area list (or a coverage summary) so complete can judge; if it can't judge (no area list supplied) it warns rather than hard-blocks. On success it still stores the summary + quality signals (conceptCount, lacking-codeAreas count, domain presence, byType) added earlier.
- **Playbook + tool descriptions** teach: "for a large project expect 200–800+ concepts; do NOT stop at a few dozen; loop status→index until coverage is broad; only then complete." Engine change is `onboard.ts` (playbook text + a pure `computeCoverage(concepts, areaList)` helper); cloud/local handlers thread it through `mcp.ts` / the stdio server + contracts (status/complete output schemas gain `coverage`, bump CONTRACTS_VERSION). This coverage machinery is REUSED by the `sync` epic (drift = areas whose code changed since last sync).

### Vault membership & email invites (Wave M — the SHIPPABLE cut of Wave P)

Keep the term **vault** (do NOT rename to project — that migration is out of scope). Add multi-user membership on top of the existing single-owner vaults, with **email-delivered invite links** (reuse the send_email + magic-link infra) and **three roles: owner / editor / viewer**.

- **Schema (D1, additive migration):**
  - `vault_member(id text pk, vault_id → vault, user_id → user, role text ["owner"|"editor"|"viewer"], created_at)` — unique (vault_id, user_id). Backfill: every existing `vault.owner_id` becomes an `owner` `vault_member` row (keep `vault.owner_id` as the canonical creator/last-owner marker; membership is the access source of truth going forward).
  - `vault_invite(id text pk, vault_id → vault, email text, role text, token_hash text, invited_by → user, created_at, expires_at [+14d], accepted_at nullable)` — email stored normalized-lowercase; token single-use, SHA-256 hashed at rest.
- **Access model (replaces owner-only checks in `vault-access.ts`):** a session user may access a vault iff they have a `vault_member` row.
  - `owner` — full control: rename/delete vault, manage API keys, invite/remove members, change roles, everything editors can do. Last owner cannot leave or be demoted.
  - `editor` — read + write concepts/tasks, use all data-plane MCP tools + the write tools (upsert/link/create_task/take_task/complete_task), but CANNOT manage members/keys or delete the vault.
  - `viewer` — read-only: browse graph, search, get_context/get_related/list — NO upserts/task mutations; no member/key management. (MCP: viewers' bearer keys — if a viewer can mint keys, keys inherit viewer scope; but key management stays owner-only, so viewers get keys only if an owner makes one. Simplest: bearer keys carry the vault's data-plane scope; enforce role at the tool handler for write tools when the key's creator is a viewer — OR keep keys owner/editor-mintable only. Agent's call; document it.)
  - Enforce role at every REST route + MCP tool handler. Foreign-vault (non-member) access stays **404, not 403** (no tenancy-existence leak) — extend the existing cross-tenant probe tests to members-of-A-probing-B.
- **Invite flow (email link, reusing send_email/magic-link):**
  - Owner (in vault settings) enters an email + picks a role → creates a `vault_invite` (normalized email, hashed token, +14d) and SENDS an invite email via the `Mailer` (`sendInvite({to, url, vaultName, role})` — the template scaffolding already exists in mailer.ts) with an `/invite/<token>` link.
  - Recipient opens `/invite/<token>`: if not signed in, they sign in via magic link (the invite page can trigger a magic-link send for the invited email, or accept after a normal sign-in) — the acceptor MUST end up authenticated as the invited email (case-insensitive match to the invite's email; mismatch → clear error). On accept: create the `vault_member` row with the invite's role, stamp `accepted_at`, redirect into the vault. Single-use; expired/used/wrong-email → clear error page.
  - Owners can list/revoke pending invites and re-send.
- **REST:** `GET/POST /api/vaults/:id/members` (list; POST not used — members come via invite accept), `PATCH /api/vaults/:id/members/:userId` (change role, owner-only), `DELETE /api/vaults/:id/members/:userId` (remove, owner-only; or self-leave); `GET/POST /api/vaults/:id/invites` (list/create, owner-only), `DELETE /api/vaults/:id/invites/:inviteId` (revoke); `POST /api/invites/:token/accept`. All owner-gated where noted; all membership-checked.
- **UI (Obsidian-dark):** vault settings gains a **Members** section (list with role badges, change-role dropdown for owners, remove/leave) and an **Invites** section (invite-by-email form with role select, pending-invite list with copy-link + revoke + resend). Dashboard lists vaults the user is a MEMBER of (not just owner of) with a role badge. `vault_stats`/stats may expose `memberCount`.
- **Contracts:** member/invite/role zod schemas + role enum in `@brainz/contracts`; CONTRACTS_VERSION bump. Dashboard fetch client + tests consume them.
- Deliberately NOT in this cut: renaming vault→project, the project-picker header, per-project embedding caps (those stay in the broader Wave P).

### Passwordless auth (magic link) + email (Wave A)

Auth becomes **magic-link only — passwordless**. Email delivery via Cloudflare's `send_email` Worker binding (MailChannels transport).

- **Better Auth**: enable the `magicLink` plugin; REMOVE email+password (no credential provider). Sign-in = enter email → receive a one-time link → click → session. Sign-up = same flow (first magic-link for an unknown email creates the user). Keep GitHub OAuth conditional as-is.
- **The claim/invite flows collapse into magic links**: ~~agent `signup` still provisions user+vault+API key and returns a `loginUrl` (a magic link that signs the human straight in)~~ **SUPERSEDED by Wave G — `signup` returns no URL of any kind; the agent-held `loginUrl` (and its 10-min `AGENT_MAGIC_LINK_TTL_SECONDS` minter) is removed.** The old `account_claims`/password (`password.ts`, PBKDF2) machinery stays REMOVED; project invites (Wave P) likewise become magic-link joins. `/claim/[token]` is revived by Wave G as the claim-approval page (not a set-password page).
- **Email**: `Mailer` interface (`sendMagicLink({to, url})`, `sendInvite(...)`) with two implementations: `MailChannelsMailer` (uses the `SEND_EMAIL` binding — `wrangler.jsonc` `send_email: [{ name: "SEND_EMAIL" }]`, `nodejs_compat`; from `no-reply@brownmatter.ai`, DKIM-signed) and a `DevMailer` (logs the URL to stderr — used in `wrangler dev`/tests where no binding/DKIM exists). Select by binding presence. HTML + text templates, Brownmatter-branded, one clear button. Never log the token in prod; DevMailer logging is dev-only.
- **Security hardenings folded in** (from the audit):
  - **Rate limiting** (was HIGH): magic-link REQUEST endpoint gets a D1-backed per-IP + per-email limiter (e.g. 5/hour/email, 20/hour/IP) mirroring the `signup_events` pattern — survives per-request Worker instances (Better Auth's in-memory limiter does not). Prevents mail-bombing an address and enumeration.
  - **Fail-closed secret** (was MEDIUM): `createAuth` THROWS if `BETTER_AUTH_SECRET` is absent when origin is production; dev fallback only under `import.meta.env.DEV`.
- **Magic-link tokens**: single-use, short TTL (~15 min), hashed at rest — Better Auth plugin defaults, verified. Delivered only via the Mailer.
- **Deploy-day (user)**: create the MailChannels account, add the DKIM TXT + domain-lockdown records for brownmatter.ai so `no-reply@brownmatter.ai` sends. Until then DevMailer/console is the fallback (documented). Also delete the stale `brain.brownmatter.ai` DNS record (currently 530).
- Contracts/UI: signup output `claimUrl`→`loginUrl` (CONTRACTS_VERSION bump); login/signup pages become one email-entry form + "check your inbox" state; settings/docs mention passwordless. E2E: request-link → DevMailer captures URL → follow it → session; rate-limit boundary; no password paths remain.

### Agent self-signup guardrails: anonymous signup + claim-to-persist + self-onboard skill (Wave G)

Threat model this wave closes (from the July 2026 review): (1) `signup` required an email and immediately created a PERMANENT account + key with no human approval ever; (2) the returned `loginUrl` was a session-granting URL handed into agent context/logs — the agent could open it itself, minting a session and laundering `emailVerified: true` without any inbox proof; (3) email squatting — an agent could register any unowned address, whose real owner would later magic-link in and silently inherit a vault with an attacker-held API key; (4) signup's "already exists" error was an account-enumeration oracle. The fix inverts the model: **anonymous ephemeral signup; persistence requires the inbox owner to approve an EMAILED link.**

**Signup v2 (public MCP `signup`)** — see the amended "Agent-driven signup" section above. Summary: `{vaultName?, email?}` → provisional account (placeholder email `unclaimed-<userId>@pending.brainz.invalid`, `expires_at = now + 7d` — new nullable `expires_at` D1 column on `user`), vault, API key; output `{apiKey, vaultSlug, expiresAt, claimEmailSent}` (strict; CONTRACTS_VERSION bump); never any URL. Supplying `email` just auto-fires a claim request.

**`claim` tool (authenticated MCP surface — cloud-only, NOT in `MCP_TOOLS`)**:

- Contract lives in `@brainz/contracts` as a cloud-only registry (e.g. `CLOUD_MCP_TOOLS`) registered ONLY by apps/cloud's authenticated server alongside the vault tools; the local stdio server never sees it.
- Input `{email}` (validated format). Resolves the calling key → vault → owner. Already-claimed owner (`expires_at` null / non-placeholder email) → isError "already claimed — manage keys in settings".
- Mints a **claim token**: 32 random bytes, SHA-256 hash at rest in new `account_claims` table `(id, user_id, email, token_hash unique, created_at, expires_at +24h, approved_at nullable)`. A new request supersedes (deletes) the user's prior pending claims.
- Delivery is **EMAIL ONLY** via the Mailer (`sendClaimApproval({to, url, vaultName, keyName, keyPrefix})`, branded template: "An agent set up a Brainz workspace and wants to attach it to your email — review and approve"). The URL (`/claim/<token>`) is NEVER present in the tool result. If the address already has an account, send a notice email instead (no token: "an agent tried to attach a workspace to your address — you already have an account; sign in to review"). Tool output is identical either way: `{status: "sent", expiresAt}` — no enumeration oracle.
- Rate limits: claim requests are counted in `magic_link_events` under the existing guard limits (5/hour/email, 20/hour/IP) — same abuse surface (unsolicited email to arbitrary addresses).

**`/claim/[token]` approval page (revived route)**:

- Load: SHA-256 the token, fetch unexpired unapproved claim; show what's being approved — the email being bound, vault name, API key name + `keyPrefix`, workspace created date, and copy stating an agent will retain access via that key. Invalid/expired/used → clear error page with "ask your agent to request a new claim" guidance.
- **Approve** (form action, atomic): re-validate; set `user.email = claim.email`, `emailVerified = true`, clear `user.expires_at`, fix placeholder `name`; stamp `approved_at`; delete the user's other pending claims; sign the human in (server-side session mint — e.g. an internally-minted magic-link verify redirect served ONLY to this browser; implementation is agent's call) and land on /dashboard. Single-use: a consumed token never approves twice.
- **Decline** (form action): delete the pending claim; the workspace simply expires on schedule. Copy tells the human nothing else is needed and nothing was attached to their email.
- Approval is the ONLY path that flips a provisional account permanent; the session-create `emailVerified` hook (Wave A hardening) stays as-is.

**Expiry enforcement**: `resolveApiKey` (the single bearer-auth chokepoint for REST + MCP) loads the key's vault owner and rejects when `expires_at < now` (401, "workspace expired unclaimed — sign up again, or ask your human to approve the claim email"). Hard deletion/purge of expired rows + DO storage is deferred (expired accounts are inert); an admin purge script may come later.

**Self-onboard skill (user-facing deliverable)**: a single copy-paste markdown doc a user drops into their agent of choice (Claude Code, Cursor, any MCP client) so the AGENT can set Brainz up end-to-end.

- Canonical file: `apps/cloud/static/skill.md`, served at `https://brainz.brownmatter.ai/skill.md`; plus a `/skill` page in the app UI (marketing-style, session not required) that renders it with a one-click "copy system prompt" button; splash page links to it ("Set up via your agent").
- Content = a SYSTEM PROMPT for the agent covering: what Brainz is (shared product-knowledge graph for agent fleets); connecting over MCP (`claude mcp add --transport http brainz https://brainz.brownmatter.ai/mcp --header "Authorization: Bearer bz_..."` + raw `.mcp.json` equivalent); calling `signup` unauthenticated (keep `apiKey` secret — never log/echo it; note the 7-day unclaimed expiry); persisting via `claim` (ask the human for their email, call `claim`, tell the human to open the approval email — the agent never sees the link); running `onboard` to index the product; the vault toolset (search/get_context/upsert/tasks/sync) and when to use each; security rules (never print keys, never ask the human to forward the approval email).
- The skill text must match the shipped contracts exactly (tool names, input shapes, expiry windows) — treat drift as a bug.

**Verification (Wave G)**: unit tests for signup v2 (anonymous + with-email), claim request (eligible / already-claimed / already-registered / rate-limited), approval action (happy, expired, reuse, decline), expiry enforcement at `resolveApiKey`; e2e: signup → key works → claim → DevMailer captures approval URL → approve → human session on /dashboard → key still works and account is permanent; and signup → never claim → clock past expiry → key 401s.

### Brand model

- **Brownmatter** = the company / parent brand. The marketing site at `brownmatter.ai` presents Brownmatter.
- **Brainz** = the product (the app, dashboard, graph, MCP server, CLI). Lives at `brainz.brownmatter.ai`.
- The marketing site markets Brainz-the-product under the Brownmatter-the-company banner (e.g. footer "Brainz is a Brownmatter product").
- The app moved from the retired `brain.brownmatter.ai` to `brainz.brownmatter.ai` — `brain.*` is replaced entirely (no redirect kept).
- Infra names (npm `@brainz/*`, worker `brainz-cloud`/`brainz-marketing`, D1 `brainz`, CLI `brainz`, `bz_` keys, `BRAINZ_VAULT`) are unchanged — they already say "brainz", which matches the product name.

### Legal & support pages (connector-directory requirement)

- The marketing site serves `/privacy`, `/terms` and `/support` (prerendered, `apps/marketing/src/routes/{privacy,terms,support}`). Operator: **Plutocracy Pty Ltd**; governing law Victoria, Australia; contact `support@brownmatter.ai`. Wording approved by James 2026-10-28 — it is a legal text, so change it only with his approval.
- The privacy policy states only what the code does: what D1 + VaultDO store, Cloudflare as the processor (Workers, D1, DOs, Email Service, Workers AI embeddings + default dreaming), GitHub only for "Continue with GitHub", BYOK dreaming providers, retention per object, and the gaps (no self-serve account deletion — by email within 30 days; unclaimed workspaces and rate-limit rows not auto-purged). **When storage, processors or retention change, update `/privacy` in the same change.**
- Linked from: the marketing footer (every page), the app splash and auth card (`LegalLinks`, plus "By continuing you agree…" on `/login`/`/signup`), the signed-in header (Support), and the discovery cards' `_meta` (`privacyPolicy`, `termsOfService`, `support`, `supportEmail`). `check-build.mjs` and `discovery.test.ts` guard these.

### Branding

Logo mark (Brainz, the product): a custom zombie half-eaten brain SVG — flat pink two-lobe brain with fold squiggles, a scalloped bite out of the right side, and sickly-green ooze crumbs (`apps/cloud/src/lib/components/Mark.svelte`) — the brand joke, played straight against a polished dark UI. Wordmark: zombie-brain mark + "Brainz". Favicon: the same SVG as an inline data-URI. The 💩 (pile of poo) emoji remains the Brownmatter *company* mark (marketing wordmark "💩 Brownmatter", site favicon/touch icon). Emails fall back to 🧠 for the product mark (inline SVG is unsupported in email clients). Marketing site lives at brownmatter.ai; the app at brainz.brownmatter.ai.

### UI (Svelte 5, `src/routes/(marketing)` + `(app)`)

- Landing `/`: the pitch — "give your agent fleet a shared brain"; explains orchestrator → get_context → subagent flow; free-for-everyone; CTA to sign up.
- `/login`, `/signup` (Better Auth client; GitHub button conditional).
- `(app)` (session-guarded via layout load): `/dashboard` — vault list + create; `/v/[slug]` — vault view: force-directed graph (port packages/web's d3-force logic into a Svelte component; nodes by type, pending gray-dashed, hover/zoom/drag/focus), side panel with rendered markdown (same sanitization rules), concept editor (create/edit: title, type, tags, markdown body with preview), search box, delete with confirm.
- `/v/[slug]/settings` — rename, API keys (create → show token once, list, revoke), MCP setup snippet with the vault's key placeholder, danger zone (delete vault).
- Loading/error states everywhere; no external CDN assets.

### File ownership (multi-agent discipline)

- Backend agent owns: `wrangler.jsonc`, `drizzle/**`, `src/lib/server/**`, `src/hooks.server.ts`, `src/routes/api/**`, `src/routes/mcp/**`, `apps/cloud/package.json` (installs ALL deps upfront, including UI's: d3-force, marked), root workspace edit, `src/app.d.ts`, `.dev.vars.example`, root `+layout.server.ts` session load.
- UI agent owns: `src/routes/(marketing)/**`, `src/routes/(app)/**`, `/login`, `/signup` routes, `src/lib/components/**`, `src/lib/api.ts` (typed fetch client), `src/app.css`. UI agent MUST NOT edit backend-owned files or run npm install for new packages (deps are pre-installed; if one is missing, note it in the final report instead).

### Verification

- Vitest where feasible (engine logic, zod schemas, pure server helpers; `@cloudflare/vitest-pool-workers` if it cooperates — don't sink hours into it).
- Real check: `wrangler dev` (or `vite dev` with platformProxy) + scripted curl: signup → session cookie → create vault → create concepts → search → context → create key → MCP initialize/tools/list/get_context over HTTP with bearer. Embeddings may be unavailable locally — assert graceful keyword-only.
- `wrangler deploy` is left to the user (needs their CF login); README documents: create D1 db, put ids in wrangler.jsonc, run migrations, set secrets, deploy.
