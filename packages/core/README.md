# @brainz/core

Vault engine for Brainz: parses a directory of markdown concept notes into a
SQLite-backed knowledge graph with keyword (FTS5), semantic, and hybrid search,
graph traversal, and agent-context assembly.

```ts
import { Vault } from "@brainz/core";

const vault = await Vault.open("./my-vault");
const hits = await vault.search({ query: "session auth" });
const bundle = await vault.assembleContext({ query: "auth", tokenBudget: 4000 });
vault.close();
```

## Vault layout

```
my-vault/
  brainz.config.json   # { "name": "...", "embedding": { "provider": "local" | "openai" | "none" } }
  concepts/            # *.md notes (may be nested)
  .brainz/index.db     # derived SQLite index (gitignore this)
```

`Vault.open()` creates missing dirs/config and reindexes. Markdown files are the
source of truth; the index is fully rebuildable via `vault.reindex()`.

## Embeddings (optional)

- `"local"` (default config): uses `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`).
  The package is loaded lazily via dynamic import and is **not** a dependency of
  this package — run `npm i @xenova/transformers` in your project to enable local
  embeddings. If it is missing or fails to load (e.g. offline), search degrades
  gracefully to keyword-only.
- `"openai"`: `text-embedding-3-small` via `fetch`, key from `OPENAI_API_KEY`.
  Missing key → keyword-only fallback.
- `"none"`: embeddings skipped entirely.

`vault.embeddingStatus` (`"ready" | "unavailable"`) reports whether semantic
search is active. `search({ mode: "hybrid" | "semantic" })` silently falls back
to keyword search when embeddings are unavailable — it never crashes.
