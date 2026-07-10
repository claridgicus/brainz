# Brainz

A product-knowledge graph with an MCP server, built for **agent orchestration**.

Product concepts — domains, features, stories, specs, workflows, decisions, constraints,
patterns, glossary terms — live as markdown notes wired into a graph by wiki-links and
typed relations. The primary consumer is not a human but an **orchestrator agent**: before
delegating a coding task, the orchestrator calls `get_context` over MCP and injects the
returned markdown bundle into the subagent's prompt. Coding agents get precise, curated
product knowledge; the orchestrator's own context stays clean.

Getting the knowledge in is agent-driven too: the `onboard` MCP tool (or `brainz onboard`)
hands the calling agent a playbook for indexing an existing codebase into the vault —
domains first, then the features `part_of` them, the stories they're `realized_by`, the
specs that `govern` them, and the workflows across them, every concept carrying
`code_areas` (rough paths/globs) that tell the next agent where in the codebase the
knowledge applies. Until onboarding completes, search and context responses carry a
one-line nudge to run it.

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
  brainz.config.json   # { "name": "...", "embedding": { "provider": "cloudflare" | "local" | "none" } }
  concepts/            # all *.md notes, may be nested in subfolders
  .brainz/             # derived SQLite index — gitignored, rebuilt from markdown
```

Notes are markdown with YAML frontmatter, inline `[[wiki-links]]`, and typed relations:

```markdown
---
id: auth-session-model        # slug; defaults to filename-without-ext; unique per vault
title: Auth Session Model
type: concept                 # concept | domain | feature | story | spec | workflow | decision | constraint | pattern | glossary
product: acme-app             # optional grouping key
tags: [auth, backend]
status: active                # active | draft | deprecated
code_areas:                   # optional: rough codebase paths/globs this knowledge lives in
  - src/auth/session.ts
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
| `upsert_concept` | `{id?, title, body, type?, product?, tags?, codeAreas?, relations?}` | saved concept meta |
| `link_concepts` | `{from, to, relation?}` | ok |
| `list_concepts` | `{product?, type?, tag?}` | metas |
| `vault_stats` | `{}` | VaultStats (incl. `onboarded`) |
| `onboard` | `{action: start\|complete\|status, productName?, repoHint?, summary?}` | the onboarding playbook / status / completion |

Relations are free-form strings; the documented conventions are `part_of`, `realized_by`,
`governs`, `depends_on`, `constrains`, `supersedes`, `related_to` (a story is `part_of` its
domain and `realized_by` features; a spec `governs` what it constrains).

## CLI

```
brainz init [dir]                      # scaffold vault + config + sample note
brainz onboard [--status | --complete --summary "..."]   # onboarding playbook / progress / completion
brainz add <title> [--type --product --tags --code-areas --body|--stdin]
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
  contracts/   # @brainz/contracts  — zod source of truth for every wire shape: MCP tool registry, cloud REST API, CLI --json (Workers-compatible)
  core/        # @brainz/core       — vault engine: SQLite/FTS5 index, hybrid search, graph, context assembly (built on engine)
  mcp-server/  # @brainz/mcp-server — MCP stdio server over core (binary: brainz-mcp)
  cli/         # @brainz/cli        — the `brainz` command
  web/         # @brainz/web        — local graph view: d3-force frontend + JSON API (/api/graph, /api/concept/:id, /api/search, /api/stats)
apps/
  cloud/       # @brainz/cloud      — Brainz Cloud: SvelteKit on one Cloudflare Worker (dashboard + REST API + remote MCP at https://brainz.brownmatter.ai; one Durable Object per vault, D1 control plane)
examples/
  demo-vault/  # seeded example vault (Acme CRM)
```

Brainz Cloud's dashboard (sign-up, vaults, graph workspace, API keys) ships at
https://brainz.brownmatter.ai — free hosted vaults over the same engine.

Agents can even provision their own account: connecting to
`https://brainz.brownmatter.ai/mcp` **without** an `Authorization` header exposes a single
public `signup` tool. One call creates a user, a first vault, and a working API key, and
returns a single-use claim URL (valid 7 days) that the agent hands to its human, who sets
a password there to take ownership of the dashboard. The API key works immediately —
password sign-in stays disabled until the account is claimed.

## Embeddings

Configured per vault in `brainz.config.json` → `embedding.provider`:

- `cloudflare` (default for new vaults) — Cloudflare Workers AI
  (`@cf/baai/bge-base-en-v1.5`, 768-dim — the same model Brainz Cloud uses, so vectors
  are portable). Needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (create one at
  dash.cloudflare.com → My Profile → API Tokens with the *Workers AI: Read* permission).
- `local` — offline alternative: `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2`,
  lazy-loaded. The package is optional; install it in your project
  (`npm i @xenova/transformers`) to enable local semantic search.
- `none` — keyword-only (the demo vault uses this so it works offline).

The v1 `openai` provider was removed — a config still saying `openai` degrades to
keyword-only with a stderr warning suggesting `cloudflare`.

Search is hybrid (reciprocal-rank fusion of FTS5 bm25 + cosine over embeddings). If the
embedding provider is unavailable — missing env vars, offline, package missing — everything
**degrades gracefully to keyword-only**; nothing crashes.
