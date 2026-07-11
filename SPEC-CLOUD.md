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

### Agent-driven signup over MCP (public toolset)

An orchestrator agent must be able to provision an account for its human straight from the MCP endpoint:

- **Unauthenticated `/mcp` connections** no longer 401: they get a PUBLIC MCP server exposing exactly one tool, `signup` `{email, vaultName?}`. (Invalid/revoked bearer still 401s — only *absent* auth gets the public server.)
- `signup` creates: a Better Auth user (email, NO password — credential set later by the human), a first vault (name default "My vault"), an API key, and a single-use **claim token** (`account_claims` table: id, user_id, token_hash SHA-256, created_at, expires_at +7d, claimed_at). Returns `{ apiKey: "bz_…", claimUrl: "https://brainz.brownmatter.ai/claim/<token>", vaultSlug, email }` — with tool-description text telling the agent to deliver the claim URL to its human and keep the key for MCP access.
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

### Passwordless auth (magic link) + email (Wave A)

Auth becomes **magic-link only — passwordless**. Email delivery via Cloudflare's `send_email` Worker binding (MailChannels transport).

- **Better Auth**: enable the `magicLink` plugin; REMOVE email+password (no credential provider). Sign-in = enter email → receive a one-time link → click → session. Sign-up = same flow (first magic-link for an unknown email creates the user). Keep GitHub OAuth conditional as-is.
- **The claim/invite flows collapse into magic links**: agent `signup` still provisions user+vault+API key and returns a `loginUrl` (a magic link that signs the human straight in) instead of a set-password claim page. The `account_claims`/password (`password.ts`, PBKDF2) machinery is REMOVED; project invites (Wave P) likewise become magic-link joins. `/claim/[token]` route retired (or redirects to magic-link sign-in).
- **Email**: `Mailer` interface (`sendMagicLink({to, url})`, `sendInvite(...)`) with two implementations: `MailChannelsMailer` (uses the `SEND_EMAIL` binding — `wrangler.jsonc` `send_email: [{ name: "SEND_EMAIL" }]`, `nodejs_compat`; from `no-reply@brownmatter.ai`, DKIM-signed) and a `DevMailer` (logs the URL to stderr — used in `wrangler dev`/tests where no binding/DKIM exists). Select by binding presence. HTML + text templates, Brownmatter-branded, one clear button. Never log the token in prod; DevMailer logging is dev-only.
- **Security hardenings folded in** (from the audit):
  - **Rate limiting** (was HIGH): magic-link REQUEST endpoint gets a D1-backed per-IP + per-email limiter (e.g. 5/hour/email, 20/hour/IP) mirroring the `signup_events` pattern — survives per-request Worker instances (Better Auth's in-memory limiter does not). Prevents mail-bombing an address and enumeration.
  - **Fail-closed secret** (was MEDIUM): `createAuth` THROWS if `BETTER_AUTH_SECRET` is absent when origin is production; dev fallback only under `import.meta.env.DEV`.
- **Magic-link tokens**: single-use, short TTL (~15 min), hashed at rest — Better Auth plugin defaults, verified. Delivered only via the Mailer.
- **Deploy-day (user)**: create the MailChannels account, add the DKIM TXT + domain-lockdown records for brownmatter.ai so `no-reply@brownmatter.ai` sends. Until then DevMailer/console is the fallback (documented). Also delete the stale `brain.brownmatter.ai` DNS record (currently 530).
- Contracts/UI: signup output `claimUrl`→`loginUrl` (CONTRACTS_VERSION bump); login/signup pages become one email-entry form + "check your inbox" state; settings/docs mention passwordless. E2E: request-link → DevMailer captures URL → follow it → session; rate-limit boundary; no password paths remain.

### Brand model

- **Brownmatter** = the company / parent brand. The marketing site at `brownmatter.ai` presents Brownmatter.
- **Brainz** = the product (the app, dashboard, graph, MCP server, CLI). Lives at `brainz.brownmatter.ai`.
- The marketing site markets Brainz-the-product under the Brownmatter-the-company banner (e.g. footer "Brainz is a Brownmatter product").
- The app moved from the retired `brain.brownmatter.ai` to `brainz.brownmatter.ai` — `brain.*` is replaced entirely (no redirect kept).
- Infra names (npm `@brainz/*`, worker `brainz-cloud`/`brainz-marketing`, D1 `brainz`, CLI `brainz`, `bz_` keys, `BRAINZ_VAULT`) are unchanged — they already say "brainz", which matches the product name.

### Branding

Logo mark: the 💩 (pile of poo) emoji — the Brownmatter brand joke, played straight against a polished dark UI. Wordmark: "💩 Brainz". Favicon: 💩 as an inline-SVG data-URI. Marketing site lives at brownmatter.ai; the app at brainz.brownmatter.ai.

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
