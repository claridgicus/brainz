# Testing — the pre-deploy gate

**One command is the mandatory gate:** `npm run test:all` (repo root, runs
`scripts/test-all.mjs`). Deploys are wired to it: both `apps/cloud` and
`apps/marketing` have npm `predeploy` hooks, so **`npm run deploy` cannot
proceed if the gate fails** (npm runs `predeploy` automatically before
`deploy`). CI (`.github/workflows/ci.yml`) runs the same command on every
push/PR: Node 20, `npm ci`, one job.

## What the gate runs (in order, fail-fast)

| # | Step | Command |
|---|------|---------|
| 1 | typecheck | `npm run typecheck --workspaces --if-present` (tsc for packages; apps/cloud's typecheck IS `svelte-check`) |
| 2 | unit tests | `npm test` for engine, contracts, core, mcp-server, cli, web, cloud (vitest) |
| 3 | svelte-check | `npm run check -w brainz-marketing` (cloud's ran in step 1) |
| 4 | build | `npm run build --workspaces --if-present` (cloud: vite build + VaultDO worker patch) |
| 5 | marketing check-build | `npm test -w brainz-marketing` — post-build assertions over `build/` |
| 6 | cloud backend E2E | `npm run e2e -w @brainz/cloud` (`scripts/e2e.mjs` vs `wrangler dev --local`) |
| 7 | cloud UI E2E | `node scripts/e2e-ui.mjs` with `E2E_UI_SKIP_BUILD=1` (reuses step 4's build) |

Any red step exits non-zero and prints a step-by-step summary; later steps
show as skipped. `apps/marketing`'s `predeploy` runs the scoped subset
(`--scope marketing`: check → build → check-build); `apps/cloud`'s runs the
full gate.

**E2E prerequisites are self-contained.** Both E2E scripts apply D1
migrations to a scratch `--persist-to` dir and boot their own
`wrangler dev --local` (ports 8788 / 8791), so no state leaks between runs
and no Cloudflare login is needed. If `apps/cloud/.dev.vars` is missing, the
gate writes a minimal one containing only `BETTER_AUTH_SECRET` —
deliberately **no `BETTER_AUTH_URL` line**, so Better Auth infers the base
URL from the wrangler-dev origin. An existing `.dev.vars` is left untouched.

## Current counts (on the merged tree — passwordless auth + gate)

| Suite | Count |
|-------|------:|
| packages/engine (vitest) | 62 |
| packages/contracts (vitest) | 45 |
| packages/core (vitest) | 48 |
| packages/mcp-server (vitest) | 30 |
| packages/cli (vitest) | 29 |
| packages/web (vitest) | 21 |
| apps/cloud unit (vitest) | 95 |
| **unit total** | **330** |
| cloud backend E2E steps | 132 |
| cloud UI E2E steps | 37 |
| marketing check-build | 1 script |

What the new tests add:

- **engine** — `assembleContext` edge cases (depth clamping, exact-budget
  boundary, the `Code areas:` line counting toward truncation, product
  filtering of product-less nodes, pending-node traversal dedupe);
  `validateGraph` mixed errors+warnings, per-edge warnings, target-only
  checking.
- **core** — `createEmbedder` unit tests with mocked `fetch`: provider
  selection (`none`/unknown/missing-creds/`local`-not-installed → `null`),
  the Workers-AI HTTP contract (URL/auth/body), batch chunking with order
  preservation, and the non-2xx / `success:false` / count-mismatch error
  paths.
- **contracts** — registry integrity: tool names unique across
  `MCP_TOOLS` + `PUBLIC_MCP_TOOLS`; every tool's input/output schema parses a
  realistic sample and rejects wrong-typed payloads; REST schemas
  (vault/keys/search/related/context/concepts/error envelope) and CLI
  `--json` schemas round-trip shipped shapes; query-param coercion bounds.
- **cloud unit** — MCP handler error paths: `link_concepts` happy + DO-404,
  `get_related` 404 and 500 (both `isError`, never protocol errors), DO
  failures on `upsert_concept`/`vault_stats`, `get_context` ids-passthrough
  with footer mirroring the bundle's truncation numbers, empty-`ids` rejection.
- **cloud backend E2E** — **tenancy probes** (the load-bearing additions): a
  second user (minted the passwordless way — a fresh magic link followed into
  its own cookie jar) gets **404** on all 15 read/write routes against user A's
  vault, A's data provably survives the probes, B cannot revoke A's key; bearer
  keys are data-plane-only (PATCH/DELETE vault, key management → 401) and stay
  404 on the owner's *other* vault; anonymous data-plane requests → 401. Plus
  validation failures for every parse boundary (12 × 400, 2 × 409, non-JSON
  body) and vault/concept lifecycle (PATCH rename, slug clash 409, DELETE →
  204 → 404).
- **cloud UI E2E** — settings SSR never leaks the plaintext `bz_` key and
  mentions the onboard tool; anon `/signup` SSR; UI tenancy: user B (also
  minted via magic link) gets 404 on A's `/v/[slug]` and settings pages, and
  B's dashboard never lists A's vault.

All tenancy probes **pass** — vault isolation behaves as specified, so there
are no failing requirement-documenting tenancy tests to report.

## Known failing / xfail tests (intentional)

None. (The concept-list-query filter bug — `GET /api/vaults/:id/concepts?type=…`
previously inlined the original 6 concept types and rejected the v3 ontology
types — **is now fixed**: `concept-list-query.ts` uses `conceptTypeSchema` from
`@brainz/contracts`, and `concept-list-query.test.ts` asserts every
`CONCEPT_TYPES` entry is a valid filter as a plain passing test.)

## Known gaps (not closed, and why)

- **Magic-link / signup rate-limit window roll-over** — needs clock control
  inside `wrangler dev`; the exact per-hour boundaries (5/email and 20/IP for
  magic-link requests, 5/IP for signups) are unit-tested, and the 6th-request
  / 6th-signup rejections are E2E-tested within one window. The magic link's
  single-use property is covered E2E (second follow mints no session).
- **Embeddings "ready" path in cloud E2E** — Workers AI requires a
  Cloudflare login even in local dev; the E2E asserts the graceful
  keyword-only degradation instead. The "ready" path is unit-tested in core
  with a mocked fetch (`packages/core/test/vault.test.ts`, `embeddings.test.ts`).
- **Client-side interactivity** — the UI E2E asserts SSR HTML over HTTP (no
  browser dependency, per the no-new-deps constraint), so canvas graph
  interactions, copy-to-clipboard, and client-side form flows are untested.
- **VaultDO internals** — exercised only through the live wrangler-dev E2E;
  there is no Workers-runtime unit harness (would need `@cloudflare/vitest-pool-workers`,
  a new dev dependency).
- **GitHub OAuth** — needs real OAuth app credentials; only the
  enabled-when-configured wiring exists.
- **Observation (not a bug):** the vault workspace UI does not surface
  onboarded state anywhere; only the settings page mentions the `onboard`
  tool. If SPEC-CLOUD wants an onboarding badge in the workspace, that is UI
  work + a new SSR assertion.
- **Domain strings are asserted in tests**: marketing `check-build.mjs` pins
  `https://brainz.brownmatter.ai/...` CTA URLs (and fails if the retired
  `brain.brownmatter.ai` host reappears), and the cloud settings SSR test
  asserts the MCP snippet URL. If the app moves domains again, those
  assertions must move with the code in the same commit or the gate goes red —
  which is exactly the point.
