/**
 * VaultDO — one Durable Object per vault; ALL vault content lives in this
 * DO's SQLite storage (`ctx.storage.sql`). Isolation comes from the DO
 * boundary: the Worker only routes into a vault's DO after auth resolves the
 * vault id (D1 control plane), so no WHERE-clause can leak another vault.
 *
 * Ranking/traversal/parsing come from @brainz/engine (extractWikiLinks,
 * bfsRelated, assembleContext, rrfFuse, cosineSim, pack/unpackVector,
 * slugify); this class is storage + orchestration only.
 *
 * Keyword search: FTS5 is attempted at schema creation — if DO SQLite
 * supports it we use bm25 + snippet(); otherwise we fall back to token/LIKE
 * scoring (do-helpers.ts). The active mode is recorded in meta and exposed
 * via stats().keywordIndex.
 *
 * Embeddings: Workers AI @cf/baai/bge-base-en-v1.5 (768-dim), recomputed on
 * content-hash change. Failures NEVER fail the write — the vault degrades to
 * keyword-only search (embeddings: "unavailable"), mirroring @brainz/core.
 *
 * Interface: fetch router (POST /<method>, JSON body) — chosen over RPC
 * because plain-fetch DO stubs work across wrangler dev sessions where DO
 * RPC does not, and the typed surface lives in vault-client.ts anyway.
 */
import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import {
  assembleContext,
  bfsRelated,
  cosineSim,
  extractWikiLinks,
  packVector,
  rrfFuse,
  slugify,
  unpackVector,
} from "@brainz/engine";
import type {
  Concept,
  ConceptMeta,
  ConceptStatus,
  ConceptType,
  Edge,
  UpsertInput,
} from "@brainz/engine";
import {
  buildGraphPayload,
  compactMeta,
  keywordScore,
  makeSnippet,
  matchSnippet,
  syntheticFilePath,
  tokenize,
} from "./do-helpers";

const SCHEMA_VERSION = 1;
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Minimal Workers AI surface (avoids model-name generics from workers-types). */
interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

interface VaultDOEnv {
  AI?: AiBinding;
}

interface ConceptRow {
  [column: string]: string | number | null;
  id: string;
  title: string;
  type: string;
  status: string;
  product: string | null;
  tags_json: string;
  relations_json: string;
  body: string;
  hash: string;
  created_at: string | null;
  updated_at: string | null;
}

class NotFoundError extends Error {}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class VaultDO {
  #state: DurableObjectState;
  #env: VaultDOEnv;
  #sql: SqlStorage;
  #fts = false;

  constructor(state: DurableObjectState, env: unknown) {
    this.#state = state;
    this.#env = (env ?? {}) as VaultDOEnv;
    this.#sql = state.storage.sql;
    state.blockConcurrencyWhile(async () => this.#initSchema());
  }

  // ------------------------------------------------------------------ schema

  #initSchema(): void {
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const version = Number(this.#metaGet("schema_version") ?? "0");
    if (version < 1) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS concept (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        product TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        relations_json TEXT NOT NULL DEFAULT '{}',
        body TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS edge (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        src TEXT NOT NULL DEFAULT 'wiki',
        PRIMARY KEY (from_id, to_id, relation)
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS embedding (
        concept_id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        hash TEXT NOT NULL
      )`);
      this.#metaSet("schema_version", String(SCHEMA_VERSION));
      if (this.#metaGet("embeddings") === null) this.#metaSet("embeddings", "ready");
    }
    // FTS5 probe: try to create the virtual table; fall back to token/LIKE
    // keyword search when DO SQLite lacks the extension.
    const recorded = this.#metaGet("keyword_index");
    if (recorded === "fts5" || recorded === "like") {
      this.#fts = recorded === "fts5";
      return;
    }
    try {
      this.#sql.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS concept_fts USING fts5(title, body, tags)`,
      );
      this.#fts = true;
      this.#metaSet("keyword_index", "fts5");
    } catch {
      this.#fts = false;
      this.#metaSet("keyword_index", "like");
    }
  }

  #metaGet(key: string): string | null {
    const rows = this.#sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
      .toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  #metaSet(key: string, value: string): void {
    this.#sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  // ------------------------------------------------------------------- fetch

  /** POST /<method> with a JSON args body; responses are JSON. */
  async fetch(request: Request): Promise<Response> {
    const method = new URL(request.url).pathname.replace(/^\//, "");
    let args: Record<string, unknown> = {};
    if (request.method === "POST") {
      try {
        args = (await request.json()) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    try {
      switch (method) {
        case "upsertConcept":
          return json(await this.upsertConcept(args as unknown as UpsertInput));
        case "deleteConcept":
          return json(this.deleteConcept(String(args.id ?? "")));
        case "getConcept":
          return json(this.getConcept(String(args.id ?? "")));
        case "list":
          return json(this.list(args as { product?: string; type?: ConceptType; tag?: string }));
        case "search":
          return json(await this.search(args as unknown as SearchArgs));
        case "related":
          return json(this.related(args as unknown as RelatedArgs));
        case "graph":
          return json(this.graph());
        case "context":
          return json(await this.context(args as ContextArgs));
        case "stats":
          return json(this.stats());
        case "link":
          return json(await this.link(args as { from: string; to: string; relation?: string }));
        case "destroy":
          return json(await this.destroy());
        default:
          return json({ error: `unknown VaultDO method: ${method}` }, 404);
      }
    } catch (err) {
      if (err instanceof NotFoundError) return json({ error: err.message }, 404);
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  // ------------------------------------------------------------------ writes

  async upsertConcept(input: UpsertInput): Promise<{ concept: WireConcept }> {
    const title = input.title?.trim();
    if (!title) throw new Error("upsertConcept requires a non-empty title");
    const id = input.id?.trim() || slugify(title);
    if (!id) throw new Error(`could not derive an id from title: ${JSON.stringify(input.title)}`);

    const existing = this.#getRow(id);
    const now = new Date().toISOString();
    const type: ConceptType = input.type ?? (existing?.type as ConceptType | undefined) ?? "concept";
    const status: ConceptStatus =
      input.status ?? (existing?.status as ConceptStatus | undefined) ?? "active";
    const product =
      input.product !== undefined ? input.product : (existing?.product ?? undefined);
    const tags =
      input.tags !== undefined ? input.tags : existing ? (JSON.parse(existing.tags_json) as string[]) : [];
    const relations =
      input.relations !== undefined
        ? input.relations
        : existing
          ? (JSON.parse(existing.relations_json) as Record<string, string[]>)
          : {};
    const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
    const createdAt = existing?.created_at ?? now;
    const hash = await sha256Hex(`${title}\n\n${body}`);

    this.#sql.exec(
      `INSERT INTO concept (id, title, type, status, product, tags_json, relations_json, body, hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, type = excluded.type, status = excluded.status,
         product = excluded.product, tags_json = excluded.tags_json,
         relations_json = excluded.relations_json, body = excluded.body,
         hash = excluded.hash, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      id,
      title,
      type,
      status,
      product ?? null,
      JSON.stringify(tags),
      JSON.stringify(relations),
      body,
      hash,
      createdAt,
      now,
    );

    this.#rebuildEdges(id, relations, body);
    this.#updateFts(id, title, body, tags);

    // Re-embed only when content changed; failures never fail the write.
    const prev = this.#sql
      .exec<{ hash: string }>(`SELECT hash FROM embedding WHERE concept_id = ?`, id)
      .toArray();
    if (prev.length === 0 || prev[0].hash !== hash) {
      await this.#tryEmbed(id, `${title}\n\n${body}`, hash);
    }

    const saved = this.#getRow(id);
    if (!saved) throw new Error(`failed to store concept: ${id}`);
    return { concept: this.#rowToWire(saved) };
  }

  deleteConcept(id: string): { ok: true; deleted: boolean } {
    const existing = this.#getRow(id);
    if (!existing) return { ok: true, deleted: false };
    this.#sql.exec(`DELETE FROM concept WHERE id = ?`, id);
    this.#sql.exec(`DELETE FROM edge WHERE from_id = ?`, id);
    this.#sql.exec(`DELETE FROM embedding WHERE concept_id = ?`, id);
    if (this.#fts) this.#sql.exec(`DELETE FROM concept_fts WHERE rowid = ?`, this.#rowidOf(id));
    return { ok: true, deleted: true };
  }

  async link(args: { from: string; to: string; relation?: string }): Promise<{
    ok: true;
    from: string;
    to: string;
    relation: string;
  }> {
    const relation = args.relation || "related_to";
    const row = this.#getRow(args.from);
    if (!row) throw new NotFoundError(`unknown concept: ${args.from}`);
    const relations = JSON.parse(row.relations_json) as Record<string, string[]>;
    const list = relations[relation] ?? [];
    if (!list.includes(args.to)) list.push(args.to);
    relations[relation] = list;
    this.#sql.exec(
      `UPDATE concept SET relations_json = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(relations),
      new Date().toISOString(),
      args.from,
    );
    this.#rebuildEdges(args.from, relations, row.body);
    return { ok: true, from: args.from, to: args.to, relation };
  }

  async destroy(): Promise<{ ok: true }> {
    await this.#state.storage.deleteAll();
    return { ok: true };
  }

  #rebuildEdges(id: string, relations: Record<string, string[]>, body: string): void {
    this.#sql.exec(`DELETE FROM edge WHERE from_id = ?`, id);
    for (const [relation, targets] of Object.entries(relations)) {
      for (const to of targets) {
        this.#sql.exec(
          `INSERT OR IGNORE INTO edge (from_id, to_id, relation, src) VALUES (?, ?, ?, 'frontmatter')`,
          id,
          to,
          relation,
        );
      }
    }
    for (const to of extractWikiLinks(body)) {
      if (to !== id) {
        this.#sql.exec(
          `INSERT OR IGNORE INTO edge (from_id, to_id, relation, src) VALUES (?, ?, 'references', 'wiki')`,
          id,
          to,
        );
      }
    }
  }

  #updateFts(id: string, title: string, body: string, tags: string[]): void {
    if (!this.#fts) return;
    const rowid = this.#rowidOf(id);
    if (rowid === null) return;
    this.#sql.exec(`DELETE FROM concept_fts WHERE rowid = ?`, rowid);
    this.#sql.exec(
      `INSERT INTO concept_fts (rowid, title, body, tags) VALUES (?, ?, ?, ?)`,
      rowid,
      title,
      body,
      tags.join(" "),
    );
  }

  #rowidOf(id: string): number | null {
    const rows = this.#sql
      .exec<{ rowid: number }>(`SELECT rowid FROM concept WHERE id = ?`, id)
      .toArray();
    return rows.length > 0 ? Number(rows[0].rowid) : null;
  }

  // -------------------------------------------------------------- embeddings

  async #tryEmbed(id: string, text: string, hash: string): Promise<void> {
    if (!this.#env.AI) {
      this.#metaSet("embeddings", "unavailable");
      return;
    }
    try {
      const result = (await this.#env.AI.run(EMBEDDING_MODEL, { text: [text] })) as {
        data?: number[][];
      };
      const vector = result?.data?.[0];
      if (!Array.isArray(vector) || vector.length === 0) throw new Error("no embedding returned");
      const packed = packVector(Float32Array.from(vector));
      const blob = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
      this.#sql.exec(
        `INSERT INTO embedding (concept_id, vector, hash) VALUES (?, ?, ?)
         ON CONFLICT(concept_id) DO UPDATE SET vector = excluded.vector, hash = excluded.hash`,
        id,
        blob,
        hash,
      );
      this.#metaSet("embeddings", "ready");
    } catch {
      // Degrade to keyword-only; never fail the write.
      this.#metaSet("embeddings", "unavailable");
    }
  }

  async #embedQuery(query: string): Promise<Float32Array | null> {
    if (!this.#env.AI || this.#metaGet("embeddings") !== "ready") return null;
    try {
      const result = (await this.#env.AI.run(EMBEDDING_MODEL, { text: [query] })) as {
        data?: number[][];
      };
      const vector = result?.data?.[0];
      if (!Array.isArray(vector) || vector.length === 0) return null;
      return Float32Array.from(vector);
    } catch {
      this.#metaSet("embeddings", "unavailable");
      return null;
    }
  }

  // ------------------------------------------------------------------- reads

  getConcept(id: string): { concept: (WireConcept & { neighbors: WireNeighbor[] }) | null } {
    const row = this.#getRow(id);
    if (!row) return { concept: null };
    const neighbors = bfsRelated(this.#edges(), id, { depth: 1 }, (nid) => this.#getMeta(nid)).map(
      (node) => {
        const edge = node.via[node.via.length - 1];
        return {
          ...compactMeta(node.concept),
          relation: edge?.relation ?? "related_to",
          direction: (edge ? (edge.from === id ? "out" : "in") : "out") as "out" | "in",
        };
      },
    );
    return { concept: { ...this.#rowToWire(row), neighbors } };
  }

  list(filter: { product?: string; type?: ConceptType; tag?: string } = {}): {
    count: number;
    concepts: ReturnType<typeof compactMeta>[];
  } {
    const rows = this.#sql.exec<ConceptRow>(`SELECT * FROM concept ORDER BY id`).toArray();
    const concepts = rows
      .map((r) => this.#rowToMeta(r))
      .filter((m) => {
        if (filter.product && m.product !== filter.product) return false;
        if (filter.type && m.type !== filter.type) return false;
        if (filter.tag && !m.tags.includes(filter.tag)) return false;
        return true;
      })
      .map(compactMeta);
    return { count: concepts.length, concepts };
  }

  async search(opts: SearchArgs): Promise<{ hits: WireHit[] }> {
    const mode = opts.mode ?? "hybrid";
    const limit = opts.limit ?? 10;
    const fetchN = Math.max(limit * 3, 50);
    const query = opts.query ?? "";

    let hits: InternalHit[];
    if (mode === "keyword") {
      hits = this.#keywordSearch(query, fetchN);
    } else {
      const semantic = await this.#semanticSearch(query, fetchN);
      if (semantic === null) {
        // Embeddings unavailable: hybrid/semantic silently fall back to keyword.
        hits = this.#keywordSearch(query, fetchN);
      } else if (mode === "semantic") {
        hits = semantic;
      } else {
        hits = rrfFuse(this.#keywordSearch(query, fetchN), semantic, (h) => h.meta.id).map(
          (e) => ({ ...e.item, score: e.score }),
        );
      }
    }

    const filtered = hits
      .filter((h) => {
        if (opts.product && h.meta.product !== opts.product) return false;
        if (opts.type && h.meta.type !== opts.type) return false;
        if (opts.tags && opts.tags.length > 0) {
          const have = new Set(h.meta.tags);
          if (!opts.tags.every((t) => have.has(t))) return false;
        }
        return true;
      })
      .slice(0, limit);

    return {
      hits: filtered.map((h) => ({
        id: h.meta.id,
        title: h.meta.title,
        type: h.meta.type,
        score: h.score,
        snippet: h.snippet,
      })),
    };
  }

  #keywordSearch(query: string, limit: number): InternalHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    if (this.#fts) {
      const ftsQuery = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
      try {
        const rows = this.#sql
          .exec<{ rowid: number; rank: number; snip: string | null }>(
            `SELECT rowid, bm25(concept_fts) AS rank,
                    snippet(concept_fts, 1, '', '', '…', 16) AS snip
             FROM concept_fts WHERE concept_fts MATCH ?
             ORDER BY rank LIMIT ?`,
            ftsQuery,
            limit,
          )
          .toArray();
        const hits: InternalHit[] = [];
        for (const row of rows) {
          const crow = this.#sql
            .exec<ConceptRow>(`SELECT * FROM concept WHERE rowid = ?`, row.rowid)
            .toArray()[0];
          if (!crow) continue;
          hits.push({
            meta: this.#rowToMeta(crow),
            score: -Number(row.rank), // bm25: lower is better → negate
            snippet: row.snip?.trim() || makeSnippet(crow.body),
          });
        }
        return hits;
      } catch {
        // Fall through to the token scorer on any FTS error.
      }
    }
    const rows = this.#sql.exec<ConceptRow>(`SELECT * FROM concept`).toArray();
    const scored: InternalHit[] = [];
    for (const row of rows) {
      const tags = JSON.parse(row.tags_json) as string[];
      const score = keywordScore(terms, { id: row.id, title: row.title, body: row.body, tags });
      if (score <= 0) continue;
      scored.push({
        meta: this.#rowToMeta(row),
        score,
        snippet: matchSnippet(row.body, terms),
      });
    }
    scored.sort((a, b) => b.score - a.score || a.meta.id.localeCompare(b.meta.id));
    return scored.slice(0, limit);
  }

  /** null → embeddings unavailable (caller falls back to keyword). */
  async #semanticSearch(query: string, limit: number): Promise<InternalHit[] | null> {
    const queryVec = await this.#embedQuery(query);
    if (!queryVec) return null;
    const rows = this.#sql
      .exec<{ concept_id: string; vector: ArrayBuffer }>(
        `SELECT concept_id, vector FROM embedding`,
      )
      .toArray();
    const scored: { id: string; score: number }[] = rows.map((row) => ({
      id: row.concept_id,
      score: cosineSim(queryVec, unpackVector(row.vector)),
    }));
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const hits: InternalHit[] = [];
    for (const { id, score } of scored.slice(0, limit)) {
      const row = this.#getRow(id);
      if (!row) continue;
      hits.push({ meta: this.#rowToMeta(row), score, snippet: makeSnippet(row.body) });
    }
    return hits;
  }

  related(args: RelatedArgs): { id: string; related: WireRelated[] } {
    if (!this.#getRow(args.id)) {
      throw new NotFoundError(
        `no concept with id "${args.id}" — use search_concepts or list_concepts to find valid ids`,
      );
    }
    const nodes = bfsRelated(
      this.#edges(),
      args.id,
      { depth: args.depth, limit: args.limit, relations: args.relations },
      (nid) => this.#getMeta(nid),
    );
    return {
      id: args.id,
      related: nodes.map((node) => ({
        ...compactMeta(node.concept),
        distance: node.distance,
        via: node.via.map((e) => ({ from: e.from, to: e.to, relation: e.relation })),
      })),
    };
  }

  graph(): ReturnType<typeof buildGraphPayload> {
    const metas = this.#sql
      .exec<ConceptRow>(`SELECT * FROM concept ORDER BY id`)
      .toArray()
      .map((r) => this.#rowToMeta(r));
    return buildGraphPayload(metas, this.#edges());
  }

  async context(args: ContextArgs): Promise<{
    markdown: string;
    included: ReturnType<typeof compactMeta>[];
    truncated: boolean;
    approxTokens: number;
  }> {
    if (!args.query && (!args.ids || args.ids.length === 0)) {
      throw new Error("context requires at least one of `query` or `ids`");
    }
    const seedIds = [...(args.ids ?? [])];
    if (args.query) {
      const { hits } = await this.search({ query: args.query, product: args.product, limit: 10 });
      seedIds.push(...hits.map((h) => h.id));
    }

    // Preload the (vault-local, synchronous) graph and drive engine logic.
    const rows = this.#sql.exec<ConceptRow>(`SELECT * FROM concept`).toArray();
    const concepts = new Map<string, Concept>();
    for (const row of rows) {
      concepts.set(row.id, { ...this.#rowToMeta(row), body: row.body });
    }
    const bundle = assembleContext(
      seedIds,
      {
        edges: this.#edges(),
        getMeta: (id) => {
          const c = concepts.get(id);
          if (!c) return null;
          const { body: _body, ...meta } = c;
          return meta;
        },
        getConcept: (id) => concepts.get(id) ?? null,
      },
      { depth: args.depth, tokenBudget: args.tokenBudget, product: args.product },
    );
    return {
      markdown: bundle.markdown,
      included: bundle.included.map(compactMeta),
      truncated: bundle.truncated,
      approxTokens: bundle.approxTokens,
    };
  }

  stats(): {
    concepts: number;
    edges: number;
    products: string[];
    tags: string[];
    byType: Record<string, number>;
    embeddings: "ready" | "unavailable";
    keywordIndex: "fts5" | "like";
  } {
    const concepts = Number(
      this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM concept`).one().n,
    );
    const edges = Number(this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM edge`).one().n);
    const products = this.#sql
      .exec<{ product: string }>(
        `SELECT DISTINCT product FROM concept WHERE product IS NOT NULL ORDER BY product`,
      )
      .toArray()
      .map((r) => r.product);
    const tagSet = new Set<string>();
    for (const row of this.#sql.exec<{ tags_json: string }>(`SELECT tags_json FROM concept`).toArray()) {
      for (const tag of JSON.parse(row.tags_json) as string[]) tagSet.add(tag);
    }
    const byType: Record<string, number> = {};
    for (const row of this.#sql
      .exec<{ type: string; n: number }>(
        `SELECT type, COUNT(*) AS n FROM concept GROUP BY type ORDER BY type`,
      )
      .toArray()) {
      byType[row.type] = Number(row.n);
    }
    return {
      concepts,
      edges,
      products,
      tags: [...tagSet].sort(),
      byType,
      embeddings: this.#metaGet("embeddings") === "ready" ? "ready" : "unavailable",
      keywordIndex: this.#fts ? "fts5" : "like",
    };
  }

  // ----------------------------------------------------------------- helpers

  #getRow(id: string): ConceptRow | null {
    const rows = this.#sql.exec<ConceptRow>(`SELECT * FROM concept WHERE id = ?`, id).toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  #getMeta(id: string): ConceptMeta | null {
    const row = this.#getRow(id);
    return row ? this.#rowToMeta(row) : null;
  }

  #rowToMeta(row: ConceptRow): ConceptMeta {
    const meta: ConceptMeta = {
      id: row.id,
      title: row.title,
      type: row.type as ConceptType,
      status: row.status as ConceptStatus,
      tags: JSON.parse(row.tags_json) as string[],
      filePath: syntheticFilePath(row.id), // engine types require it; wire shapes strip it
    };
    if (row.product !== null) meta.product = row.product;
    if (row.created_at !== null) meta.createdAt = row.created_at;
    if (row.updated_at !== null) meta.updatedAt = row.updated_at;
    return meta;
  }

  #rowToWire(row: ConceptRow): WireConcept {
    const meta = this.#rowToMeta(row);
    return {
      ...compactMeta(meta),
      ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
      ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
      body: row.body,
    };
  }

  #edges(): Edge[] {
    return this.#sql
      .exec<{ from_id: string; to_id: string; relation: string }>(
        `SELECT from_id, to_id, relation FROM edge ORDER BY from_id, to_id, relation`,
      )
      .toArray()
      .map((r) => ({ from: r.from_id, to: r.to_id, relation: r.relation }));
  }
}

// ------------------------------------------------------------- wire types

export interface WireConcept {
  id: string;
  title: string;
  type: ConceptType;
  status: ConceptStatus;
  product?: string;
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  body: string;
}

export interface WireNeighbor {
  id: string;
  title: string;
  type: ConceptType;
  status: ConceptStatus;
  product?: string;
  tags: string[];
  relation: string;
  direction: "out" | "in";
}

export interface WireHit {
  id: string;
  title: string;
  type: ConceptType;
  score: number;
  snippet: string;
}

export interface WireRelated {
  id: string;
  title: string;
  type: ConceptType;
  status: ConceptStatus;
  product?: string;
  tags: string[];
  distance: number;
  via: Edge[];
}

interface InternalHit {
  meta: ConceptMeta;
  score: number;
  snippet: string;
}

export interface SearchArgs {
  query: string;
  mode?: "hybrid" | "keyword" | "semantic";
  product?: string;
  tags?: string[];
  type?: ConceptType;
  limit?: number;
}

export interface RelatedArgs {
  id: string;
  depth?: number;
  limit?: number;
  relations?: string[];
}

export interface ContextArgs {
  query?: string;
  ids?: string[];
  product?: string;
  depth?: number;
  tokenBudget?: number;
}
