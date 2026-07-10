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
- `routes: [{ pattern: "brain.brownmatter.ai", custom_domain: true }]`
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
- **Production domain: `https://brain.brownmatter.ai`** — the user-facing dashboard AND the MCP/API host. `BETTER_AUTH_URL=https://brain.brownmatter.ai` in production (localhost in `.dev.vars`), Better Auth `trustedOrigins` includes it, and wrangler.jsonc declares the custom domain route (`routes: [{ pattern: "brain.brownmatter.ai", custom_domain: true }]`). MCP setup snippets/docs use `https://brain.brownmatter.ai/mcp`.
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

### Agent-driven signup over MCP (public toolset)

An orchestrator agent must be able to provision an account for its human straight from the MCP endpoint:

- **Unauthenticated `/mcp` connections** no longer 401: they get a PUBLIC MCP server exposing exactly one tool, `signup` `{email, vaultName?}`. (Invalid/revoked bearer still 401s — only *absent* auth gets the public server.)
- `signup` creates: a Better Auth user (email, NO password — credential set later by the human), a first vault (name default "My vault"), an API key, and a single-use **claim token** (`account_claims` table: id, user_id, token_hash SHA-256, created_at, expires_at +7d, claimed_at). Returns `{ apiKey: "bz_…", claimUrl: "https://brain.brownmatter.ai/claim/<token>", vaultSlug, email }` — with tool-description text telling the agent to deliver the claim URL to its human and keep the key for MCP access.
- Duplicate email → isError with a "this email already has an account — sign in at /login" message (no info leak beyond existence; acceptable for v1).
- **Rate limiting**: per-IP (CF-Connecting-IP) counter, max 5 signups/hour — D1 or a small DO counter; 429-style isError beyond it. Email format validated.
- `/claim/[token]` page (UI): validates token (unexpired, unclaimed), shows the account email, lets the human set a password (Better Auth credential creation using the existing PBKDF2 hasher), signs them in, marks claim used, redirects to /dashboard. Expired/used → clear error page with a "sign up again" path.
- Claimless accounts persist (their API key keeps working); only the claim token expires.
- Contract: the `signup` tool schema lives in `@brainz/contracts` as `PUBLIC_MCP_TOOLS` (same shape as MCP_TOOLS; NOT added to the 8 vault tools — the local stdio server has no accounts). Docs (`apps/marketing` /docs + app MCP snippets) mention the flow.

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

**Tasks — "take a task off the pile":**
- New type `task` (11th): a unit of work not yet reflected in the artifact. Frontmatter: `task_status: open | taken | done` (distinct from concept `status`), optional `taken_by` (free-form agent/orchestrator label) + `taken_at`. Relations: a task `realizes` stories/features, is `governed_by` specs (inverse convention of `governs`), `part_of` a domain; `code_areas` say where the work lands.
- MCP tools (authenticated surface): `list_tasks {task_status?, domain?}`; `take_task {id?}` — claims a specific task or THE NEXT open one (deterministic: oldest first), sets taken/taken_by/taken_at atomically (DO = trivially atomic; core = config-file lock is fine), and returns the task PLUS an auto-assembled context bundle for its domain/relations (get_context-grade, code areas included) — the orchestrator can fan out immediately with everything it needs; `complete_task {id, outcome}` — marks done, appends the outcome to the task body, and REMINDS the caller (in the tool result) to index what changed via upsert_concept so the graph matches the artifact.
- The contract with the orchestrator (spelled out in take_task's description + playbook): after implementing, verify the artifact matches every spec that governs the task; discrepancies → fix or record a new task; then index the new/changed knowledge.

**Drift sync — keep brownmatter true to the artifact:**
- `sync` MCP tool (+ `brainz sync` CLI): `{action: "start"}` → returns a SYNC PLAYBOOK: the vault's `last_synced_at` (+ onboarded state), all concepts' code_areas as a coverage map, and instructions: diff the codebase since last sync (git log/status since timestamp), fan out subagents over changed areas, update stale concepts, index un-mapped new work (features/stories/specs/tasks for incomplete work found), report coverage gaps (code areas no concept references). `{action: "complete", summary}` → sets `last_synced_at`, stores summary in the `product-onboarding-summary` concept (append log).
- Staleness nudge: `get_context` prefixes a one-liner when last_synced_at is older than 14 days ("knowledge may be stale — run sync"), same style as the onboarding nudge.
- Stats expose `openTasks`, `lastSyncedAt` (UI: task count chip on dashboard cards; tasks filterable in the workspace, `task` gets its own palette color + open/taken/done badge).

### Branding

Logo mark: the 💩 (pile of poo) emoji — the Brownmatter brand joke, played straight against a polished dark UI. Wordmark: "💩 Brainz". Favicon: 💩 as an inline-SVG data-URI. Marketing site lives at brownmatter.ai; the app at brain.brownmatter.ai.

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
