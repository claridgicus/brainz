# @brainz/cloud — Brainz Cloud

SvelteKit app deployed as **one Cloudflare Worker**: dashboard UI + REST API +
remote MCP at **https://brainz.brownmatter.ai**. Free hosted vaults: sign up,
create a vault, point any orchestrator at `https://brainz.brownmatter.ai/mcp`.

## Architecture

- **One Durable Object per vault** (`VaultDO`, DO SQLite storage): all vault
  content — concepts, edges, embeddings, FTS index. Isolation comes from the
  DO boundary, not WHERE clauses. All ranking/traversal/parsing comes from
  `@brainz/engine`; the DO is storage + orchestration only.
- **D1 control plane** (drizzle): Better Auth tables (user/session/account/
  verification), `vault` registry (`vault.id` is the DO name), `api_key`
  (SHA-256 hashed, plaintext shown once).
- **Auth**: Better Auth, **passwordless** — the `magicLink` plugin is the only
  credential surface (enter email → one-time link → session; unknown email
  signs up on first use). Links are single-use, hashed at rest, ~15 min TTL.
  GitHub OAuth stays available when `GITHUB_CLIENT_ID/SECRET` are set. Cookie
  sessions for the dashboard; `Authorization: Bearer bz_...` keys for the
  API/MCP, scoped to their vault. Email is delivered via the Cloudflare
  `send_email` binding (`MailChannelsMailer`) in production, or a `DevMailer`
  that logs the link when the binding is absent (local dev). Two audit
  hardenings are folded in: a D1-backed magic-link request limiter
  (5/hour/email, 20/hour/IP) and a fail-closed `BETTER_AUTH_SECRET` (missing in
  production ⇒ `createAuth` throws).
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
   npx wrangler secret put BETTER_AUTH_URL      # https://brainz.brownmatter.ai
   # optional GitHub OAuth:
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```
5. DNS: the `brownmatter.ai` zone must be on this Cloudflare account;
   `wrangler.jsonc` declares `brainz.brownmatter.ai` as a custom domain route
   (Cloudflare creates the DNS record on first deploy).
6. **Email (magic-link delivery via the `send_email` binding).** Until this is
   done, sign-in emails don't leave the platform — locally you get `DevMailer`
   (link logged to stderr), but the deployed Worker needs the domain onboarded
   for sending:
   - In the Cloudflare dashboard, onboard `brownmatter.ai` for **Email Sending**
     (Email → Email Service / Email Routing → enable sending). Cloudflare
     **auto-adds** the required DNS records to the zone: an MX (on the
     `cf-bounce` subdomain), an SPF `TXT`, a **DKIM `TXT`** (signs outbound
     mail), and a DMARC `TXT` on `_dmarc.brownmatter.ai`. Propagation is
     typically 5–15 min on Cloudflare DNS.
   - The sender is `no-reply@brownmatter.ai` — it must be on the onboarded
     domain (it is). The `send_email: [{ name: "SEND_EMAIL" }]` binding in
     `wrangler.jsonc` is already declared; no per-address verification is needed
     for the sender once the domain is onboarded.
   - **Recipient caveat (free tier):** on the name-only binding, the Worker can
     send only to **verified destination addresses** in your account. To send
     magic links to arbitrary user emails you need the expanded/paid Email
     Service sending tier — verify that before public launch, or magic-link
     delivery to non-verified recipients will fail (`E_*` send error).
   - Note: MailChannels was retired as the transport (Aug 2024); the binding now
     sends through Cloudflare's own Email Service. Same binding, same DNS.
   - Also **delete the stale `brain.brownmatter.ai` DNS record** if it still
     exists (the app moved to `brainz.brownmatter.ai`; `brain.*` currently 530s).
7. `npm run deploy`
8. Verify: sign in at https://brainz.brownmatter.ai (enter your email, open the
   magic link), create a vault + API key,
   then:
   ```sh
   claude mcp add --transport http brainz https://brainz.brownmatter.ai/mcp \
     --header "Authorization: Bearer bz_..."
   ```
   and call `vault_stats`. Or raw `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "brainz": {
         "type": "http",
         "url": "https://brainz.brownmatter.ai/mcp",
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

UI-owned: the root `+page.svelte` (splash), `/login`, `/signup`,
`src/routes/(app)/**` (session-guarded: `/dashboard`, `/v/[slug]` graph
workspace, `/v/[slug]/settings`), `src/lib/components/**`, `src/lib/api.ts`
(typed REST client — every response parsed with `@brainz/contracts`),
`src/lib/{markdown,graph-data,nav,auth-client}.ts`, `src/app.css`, and
`scripts/e2e-ui.mjs` (`node scripts/e2e-ui.mjs`: boots wrangler dev and
asserts the SSR'd auth/dashboard/workspace/settings journey). The root
`+layout.server.ts` exposes `data.user` / `data.session`; the auth client is
`createAuthClient()` from `better-auth/svelte` (`src/lib/auth-client.ts`).
