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
  brainz.config.json   # { "name": "...", "embedding": { "provider": "cloudflare" | "local" | "none" } }
  concepts/            # *.md notes (may be nested)
  .brainz/index.db     # derived SQLite index (gitignore this)
```

`Vault.open()` creates missing dirs/config and reindexes. Markdown files are the
source of truth; the index is fully rebuildable via `vault.reindex()`.

## Embeddings (optional)

- `"cloudflare"` (default config): Cloudflare Workers AI REST API with
  `@cf/baai/bge-base-en-v1.5` (768-dim, the same model Brainz Cloud uses, so
  vectors are portable between local vaults and the cloud brain). Requires two
  env vars:
  - `CLOUDFLARE_ACCOUNT_ID` — dash.cloudflare.com → your account → the id is in
    the URL (or any zone/account overview page).
  - `CLOUDFLARE_API_TOKEN` — dash.cloudflare.com → My Profile → API Tokens →
    Create Token with the **Workers AI: Read** permission.

  Texts are batched (up to 100 per request). Missing env vars, network failure,
  or a non-2xx response → graceful keyword-only fallback; a reindex never fails
  because of embeddings.
- `"local"`: fully offline alternative via `@xenova/transformers`
  (`Xenova/all-MiniLM-L6-v2`). The package is loaded lazily via dynamic import
  and is **not** a dependency of this package — run `npm i @xenova/transformers`
  in your project to enable it. If it is missing or fails to load, search
  degrades gracefully to keyword-only.
- `"none"`: embeddings skipped entirely.

The `"openai"` provider from v1 was removed: a config that still says
`"openai"` is treated as unavailable (keyword-only) with a one-line stderr
warning suggesting `"cloudflare"` — it never crashes.

`vault.embeddingStatus` (`"ready" | "unavailable"`) reports whether semantic
search is active. `search({ mode: "hybrid" | "semantic" })` silently falls back
to keyword search when embeddings are unavailable — it never crashes.
