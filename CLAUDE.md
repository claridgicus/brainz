# brainz — notes for agents

**`SPEC.md` is the product contract.** When behavior and spec disagree, the spec wins.

## Layout

npm workspaces monorepo (Node >= 20, TypeScript ~5.5, ESM throughout):

- `packages/core` — `@brainz/core`, vault engine (parse, SQLite/FTS5 index, search, graph, context assembly)
- `packages/mcp-server` — `@brainz/mcp-server`, MCP stdio server over core (binary `brainz-mcp`)
- `packages/cli` — `@brainz/cli`, the `brainz` command (binary `dist/bin.js`)
- `packages/web` — `@brainz/web`, graph-view server + esbuild-bundled frontend (`frontend/` → `dist/public`)
- `examples/demo-vault` — seeded demo vault used by tests and manual verification

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
- All ids are slugs (lowercase alnum + dashes); `slugify()` lives in core.
- Never throw raw exceptions across the MCP boundary — return `isError` content.
- Broken wiki-links are *pending* concepts: `validate` warnings, never errors.
- `.brainz/` dirs are derived SQLite state — gitignored, safe to delete, rebuilt on `Vault.open`.

Quick smoke test: `node packages/cli/dist/bin.js validate --vault examples/demo-vault`
(expect exit 0, 2 warnings, 13 concepts, 54 edges).
