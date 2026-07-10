# @brainz/cloud — Brainz Cloud

SvelteKit app deployed as **one Cloudflare Worker**: dashboard UI + REST API +
remote MCP at **https://brain.brownmatter.ai**. Free hosted vaults: sign up,
create a vault, point any orchestrator at `https://brain.brownmatter.ai/mcp`.

## Architecture

- **One Durable Object per vault** (`VaultDO`, DO SQLite storage): all vault
  content — concepts, edges, embeddings, FTS index. Isolation comes from the
  DO boundary, not WHERE clauses. All ranking/traversal/parsing comes from
  `@brainz/engine`; the DO is storage + orchestration only.
- **D1 control plane** (drizzle): Better Auth tables (user/session/account/
  verification), `vault` registry (`vault.id` is the DO name), `api_key`
  (SHA-256 hashed, plaintext shown once).
- **Auth**: Better Auth (email+password; GitHub OAuth when
  `GITHUB_CLIENT_ID/SECRET` are set). Cookie sessions for the dashboard;
  `Authorization: Bearer bz_...` keys for the API/MCP, scoped to their vault.
- **Remote MCP** (`/mcp`): stateless Streamable HTTP via `@hono/mcp`, tools
  iterated from `MCP_TOOLS` in `@brainz/contracts` (same registry as the
  stdio server).
- **Embeddings**: Workers AI `@cf/baai/bge-base-en-v1.5` on content-hash
  change; failures never fail writes — vaults degrade to keyword-only
  (`stats.embeddings: "unavailable"`). Keyword search uses **FTS5 in DO
  SQLite** (verified supported) with a token/LIKE fallback; the active mode
  is the `x-brainz-keyword-index` response header on `GET .../stats`.

### Worker entry & the Durable Object export

`@sveltejs/adapter-cloudflare` compiles the app to
`.svelte-kit/cloudflare/_worker.js` (wrangler's `main`) but cannot add named
exports — and DO classes must be exported from the entrypoint. So
`npm run build` = `vite build` + `scripts/patch-worker.mjs`, which appends
`export { VaultDO } from "../../src/lib/server/vault-do.ts"` to the generated
worker; wrangler's esbuild compiles it in at dev/deploy time. **Always build
via `npm run build`** (the `preview`/`deploy` scripts do).

## Commands

```sh
npm run dev            # vite dev (HMR) + a sidecar wrangler dev hosting VaultDO
npm run build          # vite build + append the VaultDO export to _worker.js
npm run preview        # build + wrangler dev (real workerd; needs `wrangler login` for Workers AI)
npm run preview:local  # same but --local: no login needed, AI unavailable (keyword-only)
npm run deploy         # build + wrangler deploy
npm run db:generate    # drizzle-kit generate (SQL into ./drizzle)
npm run db:migrate:local   # apply D1 migrations to local dev state
npm run db:migrate:remote  # apply D1 migrations to the real D1 database
npm test               # vitest (pure server helpers + MCP handler map)
npm run e2e            # scripted journey against wrangler dev (see below)
```

### Local dev notes

- Copy `.dev.vars.example` → `.dev.vars` first; run `npm run db:migrate:local`
  once before `npm run dev`.
- `vite dev` emulates bindings via `wrangler.dev.jsonc` (no AI binding — it is
  remote-only and would demand a Cloudflare login just to boot). Vault content
  works because `scripts/dev.mjs` also starts a sidecar `wrangler dev`
  (`wrangler.do.jsonc`) that hosts `VaultDO`; the proxy reaches it through the
  local dev registry (fetch stubs — which is why VaultDO uses a fetch router,
  not RPC).
- Local `wrangler dev` **without** a Cloudflare login must use
  `npm run preview:local` (Workers AI always needs a remote session).
  Embeddings then report `unavailable` and search is keyword-only — the same
  graceful degradation as an AI outage.

### E2E

`npm run e2e` (scripts/e2e.mjs) boots wrangler dev on a scratch state dir and
runs the full journey: signup → cookie → create vault → 3 concepts with
wiki-links + typed relations → search → related → context (token budget
respected) → graph (pending nodes) → API key (plaintext once) → MCP over HTTP
with the bearer key (initialize, tools/list = 8 tools, get_context two-block
convention, upsert_concept) → REST verification → revoked key gets 401.
Every response is validated against the `@brainz/contracts` schemas.

## Deploy runbook (first deploy)

Account-specific steps, in order:

1. `npx wrangler login`
2. `npx wrangler d1 create brainz` → paste the returned `database_id` into
   `wrangler.jsonc` (the `<REPLACE-WITH-YOUR-D1-DATABASE-ID>` placeholder).
3. `npm run db:migrate:remote` — applies `drizzle/*.sql` to the real D1.
4. Secrets:
   ```sh
   npx wrangler secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
   npx wrangler secret put BETTER_AUTH_URL      # https://brain.brownmatter.ai
   # optional GitHub OAuth:
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
5. DNS: the `brownmatter.ai` zone must be on this Cloudflare account;
   `wrangler.jsonc` declares `brain.brownmatter.ai` as a custom domain route
   (Cloudflare creates the DNS record on first deploy).
6. `npm run deploy`
7. Verify: sign up at https://brain.brownmatter.ai, create a vault + API key,
   then:
   ```sh
   claude mcp add --transport http brainz https://brain.brownmatter.ai/mcp \
     --header "Authorization: Bearer bz_..."
   ```
   and call `vault_stats`. Or raw `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "brainz": {
         "type": "http",
         "url": "https://brain.brownmatter.ai/mcp",
         "headers": { "Authorization": "Bearer bz_..." }
       }
     }
   }
   ```

Config validation without an account: `npx wrangler deploy --dry-run`
(run `npm run build` first).

## File map (backend / UI ownership)

Backend-owned (this wave): `wrangler.jsonc` (+`wrangler.dev.jsonc`,
`wrangler.do.jsonc`), `drizzle/**`, `src/lib/server/**`,
`src/hooks.server.ts`, `src/routes/api/**`, `src/routes/mcp/**`,
`src/app.d.ts`, `src/routes/+layout.server.ts`, `scripts/**`, `package.json`.

UI-owned (next wave): `src/routes/(marketing)/**`, `src/routes/(app)/**`,
`/login`, `/signup`, `src/lib/components/**`, `src/lib/api.ts`,
`src/app.css`. All UI deps (d3-force, marked, better-auth's svelte client)
are pre-installed. The root `+layout.server.ts` already exposes
`data.user` / `data.session`; create the auth client with
`createAuthClient()` from `better-auth/svelte`.
