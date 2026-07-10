# Brainz — Product Knowledge Graph for Agent Orchestration

## Vision

Brainz is an Obsidian-like knowledge vault whose primary consumer is **not a human — it's an orchestrator agent**. A product's concepts (features, decisions, constraints, patterns, glossary) live as markdown notes linked into a graph. Coding agents working on a feature query Brainz over **MCP** to pull only the concepts relevant to their task — so the orchestrator's context stays clean and subagents get precise, curated product knowledge.

## Monorepo layout (npm workspaces)

```
brainz/
  package.json            # workspaces: ["packages/*"], name: "brainz-monorepo", private
  tsconfig.base.json      # strict, ES2022, NodeNext modules, composite refs
  packages/
    core/                 # @brainz/core   — vault engine (parse, index, search, graph)
    mcp-server/           # @brainz/mcp-server — MCP stdio server over core
    cli/                  # @brainz/cli    — `brainz` command
    web/                  # @brainz/web    — local graph-view web app
  examples/
    demo-vault/           # seeded example vault (a fictional SaaS product)
```

- Node >= 20, TypeScript ~5.5, ESM throughout (`"type": "module"`).
- Build: `tsc -b` per package; web frontend bundled with `esbuild`.
- Tests: `vitest` in each package. Root scripts: `build`, `test`, `typecheck`.

## Vault format

A vault is a directory:

```
my-vault/
  brainz.config.json      # { "name": "...", "embedding": { "provider": "cloudflare" | "local" | "none" } }
  concepts/               # all *.md notes, may be nested in subfolders
  .brainz/                # derived data, gitignored: index.db (SQLite)
```

### Note format

```markdown
---
id: auth-session-model        # slug; defaults to filename-without-ext; unique per vault
title: Auth Session Model
type: concept                 # concept | feature | decision | constraint | pattern | glossary
product: acme-app             # optional grouping key
tags: [auth, backend]
status: active                # active | draft | deprecated
relations:                    # optional TYPED edges (in addition to inline wiki-links)
  depends_on: [jwt-tokens]
  part_of: [auth-system]
---

Body is markdown. Inline [[jwt-tokens]] wiki-links create edges of
relation "references". [[jwt-tokens|display text]] also supported.
```

Edge types: `references` (inline links) plus any key under `relations:` (conventional: `depends_on`, `part_of`, `constrains`, `supersedes`, `related_to`). Edges are directed; traversal may follow both directions.

## `@brainz/core` public API (exact contract — other packages import this)

```ts
// ---- types ----
export type ConceptType = "concept" | "feature" | "decision" | "constraint" | "pattern" | "glossary";
export type ConceptStatus = "active" | "draft" | "deprecated";

export interface ConceptMeta {
  id: string; title: string; type: ConceptType; status: ConceptStatus;
  product?: string; tags: string[]; filePath: string;      // absolute path
  createdAt?: string; updatedAt?: string;                  // ISO dates from frontmatter if present
}
export interface Concept extends ConceptMeta { body: string /* markdown body sans frontmatter */; }

export interface Edge { from: string; to: string; relation: string; }

export interface SearchOptions {
  query: string; mode?: "hybrid" | "keyword" | "semantic";  // default "hybrid"
  product?: string; tags?: string[]; type?: ConceptType; limit?: number; // default 10
}
export interface SearchHit { concept: ConceptMeta; score: number; snippet: string; }

export interface RelatedOptions { depth?: number /* default 1, max 3 */; limit?: number; relations?: string[]; }
export interface RelatedNode { concept: ConceptMeta; distance: number; via: Edge[]; }

export interface ContextOptions {
  query?: string;            // seed via search…
  ids?: string[];            // …or explicit seeds (at least one of query/ids)
  product?: string; depth?: number /* default 1 */;
  tokenBudget?: number;      // default 4000; approx tokens = chars/4
}
export interface ContextBundle {
  markdown: string;          // assembled, ready to inject into an agent prompt
  included: ConceptMeta[]; truncated: boolean; approxTokens: number;
}

export interface UpsertInput {
  id?: string; title: string; body: string; type?: ConceptType; status?: ConceptStatus;
  product?: string; tags?: string[]; relations?: Record<string, string[]>;
}
export interface VaultStats { concepts: number; edges: number; products: string[]; tags: string[]; byType: Record<string, number>; }

// ---- entry point ----
export class Vault {
  static open(dir: string): Promise<Vault>;   // creates dirs/config if missing, opens SQLite, reindexes stale files
  readonly dir: string;
  reindex(): Promise<void>;                    // full rebuild from markdown (source of truth)
  watch(onChange?: () => void): () => void;    // chokidar watcher, returns stop fn
  search(opts: SearchOptions): Promise<SearchHit[]>;
  getConcept(id: string): Concept | null;
  related(id: string, opts?: RelatedOptions): RelatedNode[];
  edges(): Edge[];                             // all edges (for graph view)
  listConcepts(filter?: { product?: string; type?: ConceptType; tag?: string }): ConceptMeta[];
  assembleContext(opts: ContextOptions): Promise<ContextBundle>;
  upsertConcept(input: UpsertInput): Promise<Concept>;   // writes/updates the .md file, reindexes it
  link(from: string, to: string, relation?: string): Promise<void>; // default "related_to"; edits frontmatter of `from`
  stats(): VaultStats;
  close(): void;
}
```

### Index & search internals

- SQLite via `better-sqlite3`; tables `concepts`, `edges`, FTS5 table `concepts_fts(title, body, tags)`, `embeddings(id, vector BLOB /* float32 */)`. Content hash per file to skip unchanged notes on reindex.
- **Keyword**: FTS5 bm25. **Semantic**: cosine over embeddings, computed in JS (fine ≤ ~10k nodes). **Hybrid**: reciprocal-rank-fusion of the two lists.
- Embeddings pluggable: `cloudflare` (default; Workers AI REST API `POST /accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`, auth `Bearer CLOUDFLARE_API_TOKEN`, 768-dim — the SAME model Brainz Cloud uses, so vectors are portable between local vaults and brainz.brownmatter.ai; batch texts per request where the API allows) | `local` (`@xenova/transformers`, `Xenova/all-MiniLM-L6-v2`, lazy-loaded, fully offline) | `none`. If the configured provider fails (offline, missing `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`, absent optional package), **degrade gracefully to keyword-only** — never crash. `embeddingStatus` reflects it. (History: an `openai` provider shipped in v1 and was removed in favor of `cloudflare` — a vault config still saying `openai` should be treated as `cloudflare`-with-warning or `none`, not a crash.)
- `assembleContext`: seed nodes (search hits or ids) → expand graph to `depth` → rank (seed score, then distance) → concatenate as `## <title> (<id>)` sections until `tokenBudget`; set `truncated` if cut.

## `@brainz/mcp-server` — MCP tools (stdio, `@modelcontextprotocol/sdk`)

Env/arg: vault dir via `--vault <dir>` or `BRAINZ_VAULT` (default cwd). Binary: `brainz-mcp`.

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

Tool descriptions must tell an orchestrator **when** to call them (e.g. get_context: "Call before delegating a coding task; inject result into the subagent prompt."). All responses are JSON text content; get_context returns the markdown directly.

## `@brainz/cli` — `brainz` binary (commander)

```
brainz init [dir]                      # scaffold vault + config + sample note
brainz add <title> [--type --product --tags --body|--stdin]
brainz search <query> [--mode --product --limit]
brainz show <id>
brainz related <id> [--depth]
brainz link <from> <to> [--relation]
brainz context (--query <q> | --ids a,b) [--budget N]
brainz reindex | validate              # validate: broken links, dup ids, bad frontmatter → exit 1 on errors
brainz mcp [--vault dir]               # run MCP stdio server
brainz web [--vault dir --port 4680]   # run graph-view web app
```

Global `--vault <dir>` (default cwd). Human-readable output; `--json` flag for machine output.

## `@brainz/web` — graph view

- Small HTTP server (node http or express) on `--port` (default 4680): serves static frontend + JSON API: `GET /api/graph` (nodes+edges), `GET /api/concept/:id` (incl. body), `GET /api/search?q=`, `GET /api/stats`.
- Frontend: single page, **no framework needed** (or lightweight): force-directed graph via `d3-force` rendered to SVG/canvas. Color by `type`, size by degree. Click node → side panel with rendered markdown (use `marked`), list of edges, button to focus neighborhood. Search box filters/highlights. Dark theme.
- Bundle with esbuild to `dist/public`; no CDN dependencies at runtime.

## Conventions

- Never throw raw exceptions across the MCP boundary — return `isError` content.
- All ids are slugs: lowercase alnum + dashes; `slugify()` lives in core.
- Wiki-links to unknown ids are allowed (they're "pending" concepts); `validate` reports them as warnings, not errors.
