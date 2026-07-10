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
