# Brainz

A product-knowledge graph with an MCP server, built for **agent orchestration**.

Product concepts — features, decisions, constraints, patterns, glossary terms — live as
markdown notes wired into a graph by wiki-links and typed relations. The primary consumer
is not a human but an **orchestrator agent**: before delegating a coding task, the
orchestrator calls `get_context` over MCP and injects the returned markdown bundle into the
subagent's prompt. Coding agents get precise, curated product knowledge; the orchestrator's
own context stays clean.

`SPEC.md` is the product contract. `examples/demo-vault/` is a seeded vault for a fictional
SaaS product (Acme CRM).

## Quickstart

Requires Node >= 20.

```sh
npm install
npm run build            # tsc -b per package (project references), esbuild for the web frontend

# scaffold a vault
node packages/cli/dist/bin.js init my-vault

# add concepts and link them
node packages/cli/dist/bin.js add "Billing Engine" --vault my-vault --type feature --tags billing --body "Handles invoicing."
node packages/cli/dist/bin.js add "Ledger" --vault my-vault --body "Double-entry ledger."
node packages/cli/dist/bin.js link billing-engine ledger --relation depends_on --vault my-vault

# query it
node packages/cli/dist/bin.js search "billing" --vault my-vault
node packages/cli/dist/bin.js context --query "billing" --budget 800 --vault my-vault

# explore the graph in a browser (default port 4680)
node packages/cli/dist/bin.js web --vault my-vault
```

(`npm link` the CLI package — or install the workspaces — to get a global `brainz` binary;
the examples above call the built entry point directly.)

### Wiring into an agent (`.mcp.json`)

Point your MCP client (e.g. Claude Code) at the `brainz-mcp` stdio server:

```json
{
  "mcpServers": {
    "brainz": {
      "command": "node",
      "args": [
        "/absolute/path/to/brainz/packages/mcp-server/dist/bin.js",
        "--vault", "/absolute/path/to/my-vault"
      ]
    }
  }
}
```

The vault directory can also be given via the `BRAINZ_VAULT` env var (default: cwd).
`brainz mcp --vault <dir>` runs the same server through the CLI.

## Vault & note format

A vault is a directory:

```
my-vault/
  brainz.config.json   # { "name": "...", "embedding": { "provider": "local" | "openai" | "none" } }
  concepts/            # all *.md notes, may be nested in subfolders
  .brainz/             # derived SQLite index — gitignored, rebuilt from markdown
```

Notes are markdown with YAML frontmatter, inline `[[wiki-links]]`, and typed relations:

```markdown
---
id: auth-session-model        # slug; defaults to filename-without-ext; unique per vault
title: Auth Session Model
type: concept                 # concept | feature | decision | constraint | pattern | glossary
product: acme-app             # optional grouping key
tags: [auth, backend]
status: active                # active | draft | deprecated
relations:                    # typed edges (in addition to inline wiki-links)
  depends_on: [jwt-tokens]
  part_of: [auth-system]
---

Body is markdown. Inline [[jwt-tokens]] wiki-links create edges of relation
"references". [[jwt-tokens|display text]] is also supported.
```

Edges are directed; traversal may follow both directions. Wiki-links to ids that don't
exist yet are allowed — they show up as *pending* nodes in the graph and as warnings (not
errors) in `brainz validate`.

## MCP tools

| tool | input | returns |
|---|---|---|
| `search_concepts` | `{query, mode?, product?, tags?, type?, limit?}` | hits: id, title, type, score, snippet |
| `get_concept` | `{id}` | full markdown + meta + direct neighbors list |
| `get_related` | `{id, depth?, limit?, relations?}` | related nodes w/ distance & path relations |
| `get_context` | `{query?, ids?, product?, depth?, tokenBudget?}` | **the flagship**: assembled markdown bundle for injection into a coding agent's prompt |
| `upsert_concept` | `{id?, title, body, type?, product?, tags?, relations?}` | saved concept meta |
| `link_concepts` | `{from, to, relation?}` | ok |
| `list_concepts` | `{product?, type?, tag?}` | metas |
| `vault_stats` | `{}` | VaultStats |

## CLI

```
brainz init [dir]                      # scaffold vault + config + sample note
brainz add <title> [--type --product --tags --body|--stdin]
brainz search <query> [--mode --product --limit]
brainz show <id>
brainz related <id> [--depth]
brainz link <from> <to> [--relation]
brainz context (--query <q> | --ids a,b) [--budget N]
brainz reindex | validate              # validate: broken links, dup ids, bad frontmatter → exit 1 on errors
brainz mcp [--vault dir]               # run the MCP stdio server
brainz web [--vault dir --port 4680]   # run the graph-view web app
```

Global flags: `--vault <dir>` (default cwd), `--json` for machine-readable output.

## Packages

```
packages/
  engine/      # @brainz/engine     — pure platform-agnostic logic: parse, search fusion, graph traversal, context assembly (Workers-compatible)
  core/        # @brainz/core       — vault engine: SQLite/FTS5 index, hybrid search, graph, context assembly (built on engine)
  mcp-server/  # @brainz/mcp-server — MCP stdio server over core (binary: brainz-mcp)
  cli/         # @brainz/cli        — the `brainz` command
  web/         # @brainz/web        — local graph view: d3-force frontend + JSON API (/api/graph, /api/concept/:id, /api/search, /api/stats)
examples/
  demo-vault/  # seeded example vault (Acme CRM)
```

## Embeddings

Configured per vault in `brainz.config.json` → `embedding.provider`:

- `local` (default for new vaults) — `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2`,
  lazy-loaded. The package is optional; install it in your project
  (`npm i @xenova/transformers`) to enable local semantic search.
- `openai` — `text-embedding-3-small`, needs `OPENAI_API_KEY`.
- `none` — keyword-only (the demo vault uses this so it works offline).

Search is hybrid (reciprocal-rank fusion of FTS5 bm25 + cosine over embeddings). If the
embedding provider is unavailable — package missing, offline, no API key — everything
**degrades gracefully to keyword-only**; nothing crashes.
