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
- **Remote MCP** (`/mcp`, `/mcp/agent`): stateless Streamable HTTP via
  `@hono/mcp`, tools iterated from `MCP_TOOLS` in `@brainz/contracts` (same
  registry as the stdio server). `/mcp` is the directory endpoint (OAuth + lazy
  auth, `bz_` keys) and never hands out an API key; `/mcp/agent` serves the
  unauthenticated `signup` / `sign_in` agent self-signup tools and accepts
  `bz_` keys. Shared handler: `src/lib/server/mcp-endpoint.ts`.
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
worker; wrangler's esbuild compiles it in at dev/deploy time. The adapter's
default export only has `fetch`, so the same script also attaches the cron
`scheduled` handler (`src/lib/server/scheduled.ts`, triggered by
`triggers.crons` in `wrangler.jsonc`) to it. **Always build via
`npm run build`** (the `preview`/`deploy` scripts do).

## Commands

```sh
npm run dev            # vite dev (HMR) + a sidecar wrangler dev hosting VaultDO
npm run build          # vite build + append the VaultDO export to _worker.js
npm run preview        # build + wrangler dev (real workerd; needs `wrangler login` for Workers AI)
npm run preview:local  # same but --local: no login needed, AI unavailable (keyword-only)
npm run deploy         # GATED: predeploy runs the repo-root test:all first, then build + wrangler deploy
npm run db:generate    # drizzle-kit generate (SQL into ./drizzle)
npm run db:migrate:local   # apply D1 migrations to local dev state
npm run db:migrate:remote  # apply D1 migrations to the real D1 database
npm test               # vitest (pure server helpers + MCP handler map)
npm run e2e            # scripted journey against wrangler dev (see below)
```

### Deploy is gated

`npm run deploy` cannot proceed unless the monorepo's full test gate passes:
the `predeploy` hook runs `node ../../scripts/test-all.mjs` (same as
`npm run test:all` at the repo root) — typecheck, every unit suite,
svelte-check, all builds, the backend E2E journey, and the UI E2E journey.
Any red step aborts the deploy. See `TESTING.md` at the repo root.

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
   npx wrangler secret put BYOK_ENCRYPTION_KEY  # openssl rand -base64 32 — encrypts users' dream LLM keys
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
7. **MCP Registry (one-time)**: install `mcp-publisher` and run the
   `login dns --domain=brownmatter.ai` domain verification (exact steps in
   "MCP discovery & registry publication" below) so deploys can publish
   `server.json` to registry.modelcontextprotocol.io. Skippable — deploys
   just warn until it's done.
8. `npm run deploy` — builds, deploys the Worker, then auto-publishes
   `server.json` to the MCP Registry when its version is new.
9. Verify: sign in at https://brainz.brownmatter.ai (enter your email, open the
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

## Dreaming spend controls (operator)

Nightly dreams call Workers AI on the operator's account. Three controls
(SPEC-CLOUD "Dreaming → Spend controls"):

- **Daily cap per account** — `DREAM_DAILY_USD_PER_ACCOUNT` in `wrangler.jsonc`
  `vars` (default `"1"` USD per owner per UTC day, all their vaults combined).
  Raise it by editing the var and redeploying. The ledger is D1 `dream_spend`:
  ```sh
  npx wrangler d1 execute brainz --remote --command \
    "SELECT user_id, day, usd_micros / 1e6 AS usd, calls FROM dream_spend ORDER BY day DESC LIMIT 20"
  ```
- **Global kill switch** — no redeploy needed. `workers-ai` stops every
  operator-paid dream LLM call (users with their own key keep dreaming);
  `all` stops every dream LLM call. Sweeps keep running light-only and the
  Dream Diary says why.
  ```sh
  # turn operator-paid dreaming OFF
  npx wrangler d1 execute brainz --remote --command \
    "INSERT INTO control_flag (key, value, updated_at) VALUES ('dreaming_kill_switch', 'workers-ai', unixepoch() * 1000) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  # stop ALL dream LLM calls, BYOK included: same command with 'all'
  # back ON:
  npx wrangler d1 execute brainz --remote --command \
    "UPDATE control_flag SET value = 'off', updated_at = unixepoch() * 1000 WHERE key = 'dreaming_kill_switch'"
  ```
  The `DREAMING_AI_DISABLED` var (`workers-ai` | `all`) forces it from config;
  the stronger of the var and the D1 flag wins. Check with
  `dream {action: "status"}` → `killSwitch`.
- **Bring your own key** — users add an Anthropic or OpenAI-compatible key in
  vault settings → Dreaming; those dreams run outside the cap. Keys are
  AES-GCM encrypted with `BYOK_ENCRYPTION_KEY` (rotating that secret makes
  stored keys unreadable — their dreams then record `llm-error` until users
  re-enter them).

## MCP discovery & registry publication

The server advertises itself for auto-discovery; keep all three artifacts in
sync (`src/lib/server/discovery.test.ts` enforces it):

- `static/.well-known/mcp.json` — well-known discovery document (server-card /
  SEP-2127 lineage), served at `https://brainz.brownmatter.ai/.well-known/mcp.json`.
  Uses the MCP Registry `server.json` schema plus a namespaced `_meta` block
  listing the OAuth and API-key toolsets and the `/mcp/agent` self-signup
  endpoint with its unauthenticated tools (`signup`, `sign_in`).
- `static/.well-known/mcp/server-card.json` — identical content at the
  SEP-1649 alias path some clients probe.
- `server.json` (this directory) — the MCP Registry publish artifact
  (same document minus `_meta`; the registry caps `description` at 100 chars).

**Registry publication is part of `npm run deploy`**: after `wrangler deploy`,
`scripts/publish-registry.mjs` compares `server.json`'s version against the
live registry and publishes only when it's new — already-published versions
skip instantly, and a missing CLI/login warns loudly without failing the
deploy (set `MCP_PUBLISH_STRICT=1` in CI to hard-fail instead). Manual run:
`npm run registry:publish`.

One-time setup before the first publish can succeed (needs brownmatter.ai DNS
access; registry is in preview — see
https://modelcontextprotocol.io/registry/remote-servers):

1. Install the publisher CLI: `brew install mcp-publisher`, or on Linux the
   release binary (verify it against `registry_<ver>_checksums.txt`):
   ```sh
   B=https://github.com/modelcontextprotocol/registry/releases/latest/download
   curl -sL $B/mcp-publisher_linux_amd64.tar.gz | tar -xz -C ~/.local/bin mcp-publisher
   ```
2. Generate an ed25519 keypair (the maintainer's lives at
   `~/.config/mcp-registry/brownmatter-ed25519.pem`, never in the repo):
   ```sh
   openssl genpkey -algorithm Ed25519 -out key.pem
   PUB=$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)
   HEX=$(openssl pkey -in key.pem -outform DER | tail -c 32 | xxd -p -c 64)
   ```
   and verify the `ai.brownmatter/*` namespace — either DNS:
   ```
   brownmatter.ai. IN TXT "v=MCPv1; k=ed25519; p=<PUBLIC_KEY>"
   mcp-publisher login dns --domain=brownmatter.ai --private-key=<HEX_KEY>
   ```
   or HTTP (host the same `v=MCPv1; k=ed25519; p=<PUBLIC_KEY>` string at
   `https://brownmatter.ai/.well-known/mcp-registry-auth`, which lives in the
   marketing app):
   ```
   mcp-publisher login http --domain=brownmatter.ai --private-key=<HEX_KEY>
   ```
3. Verify after the next deploy:
   `curl https://registry.modelcontextprotocol.io/v0/servers?search=brainz`

Bump `version` in `server.json` and the two well-known files alongside
`SERVER_VERSION` when the surface changes — the next deploy re-publishes.

## OAuth 2.1 for MCP clients (operator)

`/mcp` accepts OAuth 2.1 access tokens alongside `bz_` keys, which is what
the Claude Connectors Directory and the ChatGPT plugin directory require.
The spec is SPEC-CLOUD.md "OAuth 2.1 for remote MCP (Wave OA)". The code
lives in `src/lib/server/oauth.ts`, `src/routes/oauth/**` and
`src/routes/.well-known/oauth-*`.

- Discovery: `/.well-known/oauth-protected-resource/mcp` (also served
  without the `/mcp` suffix) and `/.well-known/oauth-authorization-server`.
  The issuer is `BETTER_AUTH_URL`.
- Clients register through DCR (`POST /oauth/register`) or a client ID
  metadata document. No per-client setup is needed for Claude
  (`https://claude.ai/api/mcp/auth_callback`), Claude Code (loopback, any
  port) or ChatGPT (DCR).
- Try it from Claude Code: `claude mcp add --transport http brainz
  https://brainz.brownmatter.ai/mcp` (no header), then `/mcp` → authenticate.
  The browser opens the consent page and you tick one vault, several, or
  "All my vaults". A multi-vault connection adds `list_vaults`, and every
  vault tool then takes a required `vault` (slug or id). See SPEC-CLOUD.md
  "Multi-vault grants".
- **Reviewer accounts** (password login with no email step, for directory
  reviewers). The script writes the user and credential rows and can seed
  a "Brainz demo" vault from `examples/demo-vault`:

  ```sh
  node scripts/reviewer-account.mjs --directory anthropic --remote \
    --seed https://brainz.brownmatter.ai
  ```

  It prints a generated, unguessable address
  (`review-<directory>-<random>@brownmatter.ai`) and password once; enter
  both in the directory portal. Use one account per directory. Don't use a
  guessable address such as `reviewer@`: anyone could spend its five
  failed sign-ins per hour and lock the reviewer out. No inbox is needed.
  Re-run with `--email <that address>` to rotate the password. Users can't create password
  accounts (`disableSignUp`).
- **Housekeeping.** A daily cron (04:23 UTC) deletes expired codes and
  tokens, revoked grants after 30 days, grants whose last refresh token
  expired, and idle grantless DCR clients (SPEC-CLOUD.md "Housekeeping
  cron"). Fire it locally with `npx wrangler dev --test-scheduled`, then
  `curl "http://127.0.0.1:8787/__scheduled?cron=23+4+*+*+*"`.
- **Before submitting**, refresh the OpenAI egress snapshot (exempts ChatGPT's
  client registrations from the DCR limit): `node scripts/refresh-openai-egress.mjs`
  (source: https://openai.com/chatgpt-connectors.json).
- **Before submitting**, make sure no Cloudflare WAF, bot-fight or rate-limit
  rule on the `brownmatter.ai` zone blocks Anthropic's egress range
  `160.79.104.0/21`. Anthropic fetches discovery, registration and tokens
  from it, with a 10 s timeout.

## Migration 0015: one authorization code per authorize request

0015 adds two nullable columns to `oauth_code` (`request_key`, `code_nonce`)
and a unique index on `request_key`, so a double-clicked Allow gets the same
code instead of a second one (SPEC-CLOUD.md "Authorization"). It is additive:
existing rows keep NULL and never conflict. Apply it **before** deploying the
code that writes the columns (`npm run db:migrate:remote`, then
`npm run deploy`); the old code ignores them. Codes are derived from
`BETTER_AUTH_SECRET`; rotating it only affects a duplicate Allow for a request
approved in the 5 minutes before the rotation (that duplicate's code won't
exchange; reconnecting works).

## Migrations 0013–0014: multi-vault OAuth grants (deploy runbook)

0013 adds `oauth_grant_vault` (backfilled one row per existing grant) and
`vault_scope`. 0014 **rebuilds `oauth_grant`** so `vault_id` can be NULL
(an "all my vaults" grant outlives the user's last vault). The rebuild copies
`oauth_token` and `oauth_grant_vault` aside and restores them, because
dropping the old table cascades into both. Each migration file is applied
atomically by D1, so an error leaves the database as it was. These tables
hold live logins, so check the row counts on both sides. The spec is
SPEC-CLOUD.md "Multi-vault grants".

1. **Before**: pick a cutoff `T` (epoch ms, a few seconds in the past) and
   record the counts. Rows created before `T` must all survive; newer rows
   are live traffic.
   ```sh
   T=$(( $(date +%s) * 1000 - 5000 )); echo "T=$T"
   npx wrangler d1 execute brainz --remote --command "
     SELECT 'oauth_grant' AS t, COUNT(*) AS n FROM oauth_grant WHERE created_at <= $T
     UNION ALL SELECT 'oauth_token', COUNT(*) FROM oauth_token WHERE created_at <= $T
     UNION ALL SELECT 'oauth_code', COUNT(*) FROM oauth_code WHERE created_at <= $T"
   ```
2. `npm run db:migrate:remote` (applies 0013 and 0014).
3. **After**: re-run the same command with the same `T`. Every count must
   match. A grant or token can only disappear through a vault or user deletion
   in the window. Also check the join table and the new column:
   ```sh
   npx wrangler d1 execute brainz --remote --command "
     SELECT 'oauth_grant_vault' AS t, COUNT(*) AS n FROM oauth_grant_vault
     UNION ALL SELECT 'grants without a join row', COUNT(*) FROM oauth_grant g
       WHERE vault_scope <> 'all' AND NOT EXISTS (SELECT 1 FROM oauth_grant_vault WHERE grant_id = g.id)
     UNION ALL SELECT 'leftover backup tables', COUNT(*) FROM sqlite_master WHERE name LIKE '\_\_bk%' ESCAPE '\'"
   ```
   Expect 0 grants without a join row, give or take grants the old code
   minted since step 2, and 0 leftover backup tables.
4. `npm run deploy`.
5. **After deploy**: re-backfill the grants the old code minted between
   steps 2 and 4. It is idempotent, so it is safe to run more than once.
   Those grants already work without it, because a `single` grant with no
   join row covers its anchor. The re-backfill just makes the row explicit.
   ```sh
   npx wrangler d1 execute brainz --remote --command "
     INSERT OR IGNORE INTO oauth_grant_vault (grant_id, vault_id)
     SELECT id, vault_id FROM oauth_grant g
     WHERE vault_scope='single' AND vault_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM oauth_grant_vault WHERE grant_id=g.id)"
   ```
   Then re-run step 3's join-table check and expect 0.

## File map (backend / UI ownership)

Backend-owned (this wave): `wrangler.jsonc` (+`wrangler.dev.jsonc`,
`wrangler.do.jsonc`), `drizzle/**`, `src/lib/server/**`,
`src/hooks.server.ts`, `src/routes/api/**`, `src/routes/mcp/**`, `src/routes/oauth/**` (server files; the consent `+page.svelte` is UI), `src/routes/.well-known/**`,
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
