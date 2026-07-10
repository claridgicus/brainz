# brainz — notes for agents

**`SPEC.md` is the product contract.** When behavior and spec disagree, the spec wins.
**`SPEC-CLOUD.md`** extends it for `apps/cloud` (Brainz Cloud on Cloudflare).

## Layout

npm workspaces monorepo (Node >= 20, TypeScript ~5.5, ESM throughout; workspaces `packages/*` + `apps/*`):

- `packages/engine` — `@brainz/engine`, pure platform-agnostic logic (parse, slugify, RRF/cosine, BFS, context assembly, graph validation) — no fs/sqlite/node-only APIs, must stay Cloudflare Workers-compatible
- `packages/contracts` — `@brainz/contracts`, zod source of truth for every wire shape (MCP tool registry `MCP_TOOLS`, cloud REST API, CLI `--json`); mcp-server/cli consume it — Workers-compatible like engine
- `packages/core` — `@brainz/core`, vault engine over engine (SQLite/FTS5 index, file watching, embeddings); re-exports engine's public types + `slugify`
- `packages/mcp-server` — `@brainz/mcp-server`, MCP stdio server over core (binary `brainz-mcp`)
- `packages/cli` — `@brainz/cli`, the `brainz` command (binary `dist/bin.js`)
- `packages/web` — `@brainz/web`, graph-view server + esbuild-bundled frontend (`frontend/` → `dist/public`)
- `apps/cloud` — `@brainz/cloud`, SvelteKit app deployed as ONE Cloudflare Worker (https://brain.brownmatter.ai): dashboard + REST API + remote MCP `/mcp`. One Durable Object per vault (`VaultDO`, DO SQLite = all vault content); D1 is only the control plane (Better Auth, vault registry, hashed API keys)
- `examples/demo-vault` — seeded demo vault used by tests and manual verification

### apps/cloud specifics

- Commands (run in `apps/cloud`): `npm run dev` (vite HMR + a sidecar wrangler dev hosting VaultDO), `npm run preview:local` (build + wrangler dev, no CF login), `npm test` (vitest), `npm run e2e` (full journey vs wrangler dev), `npm run db:generate` / `db:migrate:local` (drizzle → D1). Copy `.dev.vars.example` → `.dev.vars` and migrate before first run.
- `npm run build` = `vite build` + `scripts/patch-worker.mjs`, which appends the `VaultDO` export to the adapter-generated `.svelte-kit/cloudflare/_worker.js` (adapter-cloudflare can't export DO classes). Never edit `_worker.js` by hand; never point wrangler `main` at a source file (the adapter overwrites whatever `main` names).
- Wire shapes come from `@brainz/contracts` (`MCP_TOOLS`, `api.ts`) — REST/MCP responses must safeParse against them; don't invent shapes.
- Backend/UI file ownership is listed in SPEC-CLOUD.md ("File ownership") and apps/cloud/README.md.

## Commands

From the repo root:

```sh
npm install
npm run build        # all packages (tsc -b; web also runs scripts/build-frontend.mjs)
npm test             # vitest per package
npm run typecheck
```

Packages use TypeScript **project references** (`composite: true`, `tsc -b`), so building
any package builds its workspace dependencies first — build order does not matter.

## Conventions

- ESM + NodeNext: relative imports **must** use `.js` extensions (`./vault.js`, not `./vault`).
- All ids are slugs (lowercase alnum + dashes); `slugify()` lives in engine (re-exported by core).
- Never throw raw exceptions across the MCP boundary — return `isError` content.
- Broken wiki-links are *pending* concepts: `validate` warnings, never errors.
- `.brainz/` dirs are derived SQLite state — gitignored, safe to delete, rebuilt on `Vault.open`.

Quick smoke test: `node packages/cli/dist/bin.js validate --vault examples/demo-vault`
(expect exit 0, 2 warnings, 13 concepts, 54 edges).
