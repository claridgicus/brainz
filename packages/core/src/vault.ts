import type DatabaseType from "better-sqlite3";
import { watch as chokidarWatch } from "chokidar";
import matter from "gray-matter";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { openDb } from "./db.js";
import {
  cosineSimilarity,
  createEmbedder,
  type Embedder,
  type EmbeddingConfig,
} from "./embeddings.js";
import { extractWikiLinks, parseNote } from "./parse.js";
import { slugify } from "./slugify.js";
import type {
  Concept,
  ConceptMeta,
  ConceptType,
  ContextBundle,
  ContextOptions,
  Edge,
  RelatedNode,
  RelatedOptions,
  SearchHit,
  SearchOptions,
  UpsertInput,
  VaultStats,
} from "./types.js";

interface VaultConfig {
  name: string;
  embedding: EmbeddingConfig;
  [key: string]: unknown;
}

interface ConceptRow {
  id: string;
  title: string;
  type: string;
  status: string;
  product: string | null;
  tags: string;
  file_path: string;
  created_at: string | null;
  updated_at: string | null;
  body: string;
  hash: string;
}

interface PendingEmbedding {
  id: string;
  text: string;
  hash: string;
}

const RRF_K = 60;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function makeSnippet(body: string, maxLen = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

export class Vault {
  readonly dir: string;

  #db: DatabaseType.Database;
  #config: VaultConfig;
  #embeddingStatus: "ready" | "unavailable";
  #embedderPromise: Promise<Embedder | null> | null = null;
  #closed = false;

  /** "ready" while embeddings are (believed) usable; "unavailable" once the
   * provider is "none", missing, or has failed. Extra field beyond SPEC.md. */
  get embeddingStatus(): "ready" | "unavailable" {
    return this.#embeddingStatus;
  }

  private constructor(dir: string, db: DatabaseType.Database, config: VaultConfig) {
    this.dir = dir;
    this.#db = db;
    this.#config = config;
    const provider = config.embedding?.provider ?? "none";
    if (provider === "none" || (provider === "openai" && !process.env.OPENAI_API_KEY)) {
      this.#embeddingStatus = "unavailable";
    } else {
      this.#embeddingStatus = "ready";
    }
  }

  /** Open (creating dirs/config if missing) and reindex a vault directory. */
  static async open(dir: string): Promise<Vault> {
    const abs = path.resolve(dir);
    await fsp.mkdir(path.join(abs, "concepts"), { recursive: true });
    await fsp.mkdir(path.join(abs, ".brainz"), { recursive: true });

    const configPath = path.join(abs, "brainz.config.json");
    let config: VaultConfig;
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(await fsp.readFile(configPath, "utf8")) as Partial<VaultConfig>;
      config = {
        ...raw,
        name: typeof raw.name === "string" && raw.name ? raw.name : path.basename(abs),
        embedding: raw.embedding ?? { provider: "local" },
      };
    } else {
      config = { name: path.basename(abs), embedding: { provider: "local" } };
      await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }

    const db = openDb(path.join(abs, ".brainz", "index.db"));
    const vault = new Vault(abs, db, config);
    await vault.reindex();
    return vault;
  }

  // ---------------------------------------------------------------- indexing

  /** Full rebuild from markdown (source of truth). Unchanged files (by content
   * hash) are skipped; embeddings are only recomputed when the hash changed. */
  async reindex(): Promise<void> {
    const files = this.#scanMarkdownFiles();
    const pending: PendingEmbedding[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(file);
      try {
        this.#indexFile(file, pending);
      } catch {
        // Unreadable/unparsable file: skip rather than crash the whole reindex.
      }
    }
    // Drop rows for files that no longer exist.
    const rows = this.#db
      .prepare("SELECT id, file_path FROM concepts")
      .all() as Pick<ConceptRow, "id" | "file_path">[];
    for (const row of rows) {
      if (!seen.has(row.file_path)) this.#removeConcept(row.id);
    }
    await this.#embedPending(pending);
  }

  /** Reindex a single file (or remove its rows if the file is gone). */
  async #reindexFile(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      const row = this.#db
        .prepare("SELECT id FROM concepts WHERE file_path = ?")
        .get(filePath) as { id: string } | undefined;
      if (row) this.#removeConcept(row.id);
      return;
    }
    const pending: PendingEmbedding[] = [];
    this.#indexFile(filePath, pending);
    await this.#embedPending(pending);
  }

  #indexFile(filePath: string, pending: PendingEmbedding[]): void {
    const raw = fs.readFileSync(filePath, "utf8");
    const hash = sha256(raw);
    const existing = this.#db
      .prepare("SELECT id, hash FROM concepts WHERE file_path = ?")
      .get(filePath) as { id: string; hash: string } | undefined;
    if (existing && existing.hash === hash) return; // unchanged: skip

    const { concept, relations } = parseNote(filePath, raw);
    if (existing && existing.id !== concept.id) this.#removeConcept(existing.id);

    this.#db
      .prepare(
        `INSERT INTO concepts (id, title, type, status, product, tags, file_path, created_at, updated_at, body, hash)
         VALUES (@id, @title, @type, @status, @product, @tags, @file_path, @created_at, @updated_at, @body, @hash)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, type = excluded.type, status = excluded.status,
           product = excluded.product, tags = excluded.tags, file_path = excluded.file_path,
           created_at = excluded.created_at, updated_at = excluded.updated_at,
           body = excluded.body, hash = excluded.hash`,
      )
      .run({
        id: concept.id,
        title: concept.title,
        type: concept.type,
        status: concept.status,
        product: concept.product ?? null,
        tags: JSON.stringify(concept.tags),
        file_path: filePath,
        created_at: concept.createdAt ?? null,
        updated_at: concept.updatedAt ?? null,
        body: concept.body,
        hash,
      });

    const { rowid } = this.#db
      .prepare("SELECT rowid FROM concepts WHERE id = ?")
      .get(concept.id) as { rowid: number };
    this.#db.prepare("DELETE FROM concepts_fts WHERE rowid = ?").run(rowid);
    this.#db
      .prepare("INSERT INTO concepts_fts (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
      .run(rowid, concept.title, concept.body, concept.tags.join(" "));

    // Rebuild outgoing edges: typed relations + inline wiki-links.
    this.#db.prepare("DELETE FROM edges WHERE from_id = ?").run(concept.id);
    const insertEdge = this.#db.prepare(
      "INSERT OR IGNORE INTO edges (from_id, to_id, relation) VALUES (?, ?, ?)",
    );
    for (const [relation, targets] of Object.entries(relations)) {
      for (const to of targets) insertEdge.run(concept.id, to, relation);
    }
    for (const to of extractWikiLinks(concept.body)) {
      if (to !== concept.id) insertEdge.run(concept.id, to, "references");
    }

    // Queue embedding only when content changed since the stored vector.
    if ((this.#config.embedding?.provider ?? "none") !== "none") {
      const emb = this.#db
        .prepare("SELECT hash FROM embeddings WHERE id = ?")
        .get(concept.id) as { hash: string } | undefined;
      if (!emb || emb.hash !== hash) {
        pending.push({ id: concept.id, text: `${concept.title}\n\n${concept.body}`, hash });
      }
    }
  }

  #removeConcept(id: string): void {
    const row = this.#db
      .prepare("SELECT rowid FROM concepts WHERE id = ?")
      .get(id) as { rowid: number } | undefined;
    if (row) this.#db.prepare("DELETE FROM concepts_fts WHERE rowid = ?").run(row.rowid);
    this.#db.prepare("DELETE FROM concepts WHERE id = ?").run(id);
    this.#db.prepare("DELETE FROM edges WHERE from_id = ?").run(id);
    this.#db.prepare("DELETE FROM embeddings WHERE id = ?").run(id);
  }

  #scanMarkdownFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
      }
    };
    walk(this.dir);
    return out.sort();
  }

  // -------------------------------------------------------------- embeddings

  async #getEmbedder(): Promise<Embedder | null> {
    if (this.#embeddingStatus === "unavailable") return null;
    this.#embedderPromise ??= createEmbedder(this.#config.embedding ?? { provider: "none" });
    const embedder = await this.#embedderPromise;
    if (!embedder) this.#embeddingStatus = "unavailable";
    return embedder;
  }

  async #embedPending(pending: PendingEmbedding[]): Promise<void> {
    if (pending.length === 0) return;
    const embedder = await this.#getEmbedder();
    if (!embedder) return;
    const insert = this.#db.prepare(
      `INSERT INTO embeddings (id, vector, hash) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET vector = excluded.vector, hash = excluded.hash`,
    );
    const BATCH = 16;
    try {
      for (let i = 0; i < pending.length; i += BATCH) {
        const batch = pending.slice(i, i + BATCH);
        const vectors = await embedder.embed(batch.map((p) => p.text));
        batch.forEach((p, j) => {
          const vec = vectors[j];
          insert.run(p.id, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), p.hash);
        });
      }
    } catch {
      this.#embeddingStatus = "unavailable"; // degrade gracefully; keyword search still works
    }
  }

  // ------------------------------------------------------------------ search

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const mode = opts.mode ?? "hybrid";
    const limit = opts.limit ?? 10;
    const fetchN = Math.max(limit * 3, 50);

    let hits: SearchHit[];
    if (mode === "keyword") {
      hits = this.#keywordSearch(opts.query, fetchN);
    } else {
      const semantic = await this.#semanticSearch(opts.query, fetchN);
      if (semantic === null) {
        // Embeddings unavailable: hybrid/semantic silently fall back to keyword.
        hits = this.#keywordSearch(opts.query, fetchN);
      } else if (mode === "semantic") {
        hits = semantic;
      } else {
        hits = this.#fuse(this.#keywordSearch(opts.query, fetchN), semantic);
      }
    }

    return hits.filter((h) => this.#matchesFilters(h.concept, opts)).slice(0, limit);
  }

  #matchesFilters(meta: ConceptMeta, opts: SearchOptions): boolean {
    if (opts.product && meta.product !== opts.product) return false;
    if (opts.type && meta.type !== opts.type) return false;
    if (opts.tags && opts.tags.length > 0) {
      const have = new Set(meta.tags);
      if (!opts.tags.every((t) => have.has(t))) return false;
    }
    return true;
  }

  #keywordSearch(query: string, limit: number): SearchHit[] {
    // Never pass raw user input to MATCH: build an FTS query from tokenized,
    // quoted terms only.
    const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 32);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    const rows = this.#db
      .prepare(
        `SELECT rowid, bm25(concepts_fts) AS rank,
                snippet(concepts_fts, 1, '', '', '…', 16) AS snip
         FROM concepts_fts WHERE concepts_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as { rowid: number; rank: number; snip: string | null }[];
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const crow = this.#db
        .prepare("SELECT * FROM concepts WHERE rowid = ?")
        .get(row.rowid) as ConceptRow | undefined;
      if (!crow) continue;
      const meta = this.#rowToMeta(crow);
      hits.push({
        concept: meta,
        score: -row.rank, // bm25: lower is better → negate so higher is better
        snippet: row.snip?.trim() || makeSnippet(crow.body),
      });
    }
    return hits;
  }

  /** Returns null when embeddings are unavailable (caller falls back to keyword). */
  async #semanticSearch(query: string, limit: number): Promise<SearchHit[] | null> {
    const embedder = await this.#getEmbedder();
    if (!embedder) return null;
    let queryVec: Float32Array;
    try {
      [queryVec] = await embedder.embed([query]);
    } catch {
      this.#embeddingStatus = "unavailable";
      return null;
    }
    const rows = this.#db
      .prepare("SELECT id, vector FROM embeddings")
      .all() as { id: string; vector: Buffer }[];
    const scored: { id: string; score: number }[] = [];
    for (const row of rows) {
      const vec = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4,
      );
      scored.push({ id: row.id, score: cosineSimilarity(queryVec, vec) });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const hits: SearchHit[] = [];
    for (const { id, score } of scored.slice(0, limit)) {
      const concept = this.getConcept(id);
      if (!concept) continue;
      const { body, ...meta } = concept;
      hits.push({ concept: meta, score, snippet: makeSnippet(body) });
    }
    return hits;
  }

  /** Reciprocal rank fusion (k = 60) of two ranked hit lists. */
  #fuse(a: SearchHit[], b: SearchHit[]): SearchHit[] {
    const fused = new Map<string, { hit: SearchHit; score: number }>();
    for (const list of [a, b]) {
      list.forEach((hit, i) => {
        const id = hit.concept.id;
        const entry = fused.get(id) ?? { hit, score: 0 };
        entry.score += 1 / (RRF_K + i + 1);
        fused.set(id, entry);
      });
    }
    return [...fused.values()]
      .sort((x, y) => y.score - x.score || x.hit.concept.id.localeCompare(y.hit.concept.id))
      .map((e) => ({ ...e.hit, score: e.score }));
  }

  // ------------------------------------------------------------------- reads

  getConcept(id: string): Concept | null {
    const row = this.#db
      .prepare("SELECT * FROM concepts WHERE id = ?")
      .get(id) as ConceptRow | undefined;
    if (!row) return null;
    return { ...this.#rowToMeta(row), body: row.body };
  }

  #getMeta(id: string): ConceptMeta | null {
    const row = this.#db
      .prepare("SELECT * FROM concepts WHERE id = ?")
      .get(id) as ConceptRow | undefined;
    return row ? this.#rowToMeta(row) : null;
  }

  #rowToMeta(row: ConceptRow): ConceptMeta {
    const meta: ConceptMeta = {
      id: row.id,
      title: row.title,
      type: row.type as ConceptMeta["type"],
      status: row.status as ConceptMeta["status"],
      tags: JSON.parse(row.tags) as string[],
      filePath: row.file_path,
    };
    if (row.product !== null) meta.product = row.product;
    if (row.created_at !== null) meta.createdAt = row.created_at;
    if (row.updated_at !== null) meta.updatedAt = row.updated_at;
    return meta;
  }

  edges(): Edge[] {
    const rows = this.#db
      .prepare("SELECT from_id, to_id, relation FROM edges ORDER BY from_id, to_id, relation")
      .all() as { from_id: string; to_id: string; relation: string }[];
    return rows.map((r) => ({ from: r.from_id, to: r.to_id, relation: r.relation }));
  }

  listConcepts(filter?: { product?: string; type?: ConceptType; tag?: string }): ConceptMeta[] {
    const rows = this.#db
      .prepare("SELECT * FROM concepts ORDER BY id")
      .all() as ConceptRow[];
    return rows
      .map((r) => this.#rowToMeta(r))
      .filter((m) => {
        if (filter?.product && m.product !== filter.product) return false;
        if (filter?.type && m.type !== filter.type) return false;
        if (filter?.tag && !m.tags.includes(filter.tag)) return false;
        return true;
      });
  }

  // ------------------------------------------------------------------- graph

  related(id: string, opts: RelatedOptions = {}): RelatedNode[] {
    const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
    if (!this.#getMeta(id)) return [];

    const allowed = opts.relations ? new Set(opts.relations) : null;
    const allEdges = this.edges().filter((e) => !allowed || allowed.has(e.relation));

    // BFS over edges in both directions.
    const visited = new Map<string, { distance: number; via: Edge[] }>();
    visited.set(id, { distance: 0, via: [] });
    let frontier = [id];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const curInfo = visited.get(cur)!;
        const neighbors: { node: string; edge: Edge }[] = [];
        for (const e of allEdges) {
          if (e.from === cur) neighbors.push({ node: e.to, edge: e });
          if (e.to === cur) neighbors.push({ node: e.from, edge: e });
        }
        neighbors.sort(
          (x, y) => x.node.localeCompare(y.node) || x.edge.relation.localeCompare(y.edge.relation),
        );
        for (const { node, edge } of neighbors) {
          if (visited.has(node)) continue;
          visited.set(node, { distance: d, via: [...curInfo.via, edge] });
          next.push(node);
        }
      }
      frontier = next;
    }

    const out: RelatedNode[] = [];
    for (const [nodeId, info] of visited) {
      if (nodeId === id) continue;
      const meta = this.#getMeta(nodeId);
      if (!meta) continue; // pending concept (broken link target)
      out.push({ concept: meta, distance: info.distance, via: info.via });
    }
    out.sort((x, y) => x.distance - y.distance || x.concept.id.localeCompare(y.concept.id));
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  // ---------------------------------------------------------------- context

  async assembleContext(opts: ContextOptions): Promise<ContextBundle> {
    if (!opts.query && (!opts.ids || opts.ids.length === 0)) {
      throw new Error("assembleContext requires at least one of `query` or `ids`");
    }
    const depth = Math.max(opts.depth ?? 1, 0);
    const tokenBudget = opts.tokenBudget ?? 4000;

    // Seeds: explicit ids first (given order), then search hits ranked by score.
    const ordered: string[] = [];
    const seen = new Set<string>();
    const push = (candidateId: string): void => {
      if (!seen.has(candidateId)) {
        seen.add(candidateId);
        ordered.push(candidateId);
      }
    };
    for (const seedId of opts.ids ?? []) {
      if (this.#getMeta(seedId)) push(seedId);
    }
    if (opts.query) {
      const hits = await this.search({ query: opts.query, product: opts.product, limit: 10 });
      for (const hit of hits) push(hit.concept.id);
    }

    // Expand to depth: neighbors ranked by distance, then id (deterministic).
    const allEdges = this.edges();
    const visited = new Set(ordered);
    let frontier = [...ordered];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const layer = new Set<string>();
      for (const cur of frontier) {
        for (const e of allEdges) {
          if (e.from === cur) layer.add(e.to);
          if (e.to === cur) layer.add(e.from);
        }
      }
      const fresh = [...layer].filter((x) => !visited.has(x)).sort();
      frontier = [];
      for (const nodeId of fresh) {
        visited.add(nodeId);
        frontier.push(nodeId);
        const meta = this.#getMeta(nodeId);
        if (!meta) continue; // pending concept
        if (opts.product && meta.product !== opts.product) continue;
        push(nodeId);
      }
    }

    // Emit sections until the budget would be exceeded.
    const included: ConceptMeta[] = [];
    const sections: string[] = [];
    let truncated = false;
    let chars = 0;
    for (const conceptId of ordered) {
      const concept = this.getConcept(conceptId);
      if (!concept) continue;
      const section = `## ${concept.title} (${concept.id})\n\n${concept.body.trim()}`;
      const addChars = section.length + (sections.length > 0 ? 2 : 0); // "\n\n" separator
      if (Math.ceil((chars + addChars) / 4) > tokenBudget) {
        truncated = true;
        break;
      }
      sections.push(section);
      chars += addChars;
      const { body: _body, ...meta } = concept;
      included.push(meta);
    }

    const markdown = sections.join("\n\n");
    return {
      markdown,
      included,
      truncated,
      approxTokens: Math.ceil(markdown.length / 4),
    };
  }

  // ----------------------------------------------------------------- writes

  async upsertConcept(input: UpsertInput): Promise<Concept> {
    const title = input.title?.trim();
    if (!title) throw new Error("upsertConcept requires a non-empty title");
    const id = input.id?.trim() || slugify(title);
    if (!id) throw new Error(`could not derive an id from title: ${JSON.stringify(input.title)}`);

    const existing = this.getConcept(id);
    let filePath: string;
    let data: Record<string, unknown>;
    if (existing) {
      filePath = existing.filePath;
      const raw = await fsp.readFile(filePath, "utf8");
      data = { ...(matter(raw).data as Record<string, unknown>) }; // preserve unknown keys
    } else {
      filePath = path.join(this.dir, "concepts", `${id}.md`);
      data = {};
    }

    data.id = id;
    data.title = title;
    if (input.type !== undefined) data.type = input.type;
    else if (data.type === undefined) data.type = "concept";
    if (input.status !== undefined) data.status = input.status;
    else if (data.status === undefined) data.status = "active";
    if (input.product !== undefined) data.product = input.product;
    if (input.tags !== undefined) data.tags = input.tags;
    if (input.relations !== undefined) data.relations = input.relations;

    const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, matter.stringify(body, data));
    await this.#reindexFile(filePath);

    const saved = this.getConcept(id);
    if (!saved) throw new Error(`failed to index upserted concept: ${id}`);
    return saved;
  }

  async link(from: string, to: string, relation = "related_to"): Promise<void> {
    const source = this.getConcept(from);
    if (!source) throw new Error(`unknown concept: ${from}`);

    const raw = await fsp.readFile(source.filePath, "utf8");
    const parsed = matter(raw);
    const data = { ...(parsed.data as Record<string, unknown>) };
    const relations =
      data.relations && typeof data.relations === "object" && !Array.isArray(data.relations)
        ? { ...(data.relations as Record<string, unknown>) }
        : {};
    const current = relations[relation];
    const list = Array.isArray(current)
      ? current.map((v) => String(v))
      : typeof current === "string" && current
        ? [current]
        : [];
    if (!list.includes(to)) list.push(to);
    relations[relation] = list;
    data.relations = relations;

    await fsp.writeFile(source.filePath, matter.stringify(parsed.content, data));
    await this.#reindexFile(source.filePath);
  }

  // ------------------------------------------------------------------ watch

  watch(onChange?: () => void): () => void {
    const watcher = chokidarWatch(this.dir, {
      ignored: (p: string) =>
        p.split(path.sep).some((seg) => seg === ".brainz" || seg === "node_modules"),
      ignoreInitial: true,
    });
    const pendingPaths = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const schedule = (p: string): void => {
      if (!p.toLowerCase().endsWith(".md")) return;
      pendingPaths.add(path.resolve(p));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const paths = [...pendingPaths];
        pendingPaths.clear();
        void (async () => {
          for (const fp of paths) {
            try {
              await this.#reindexFile(fp);
            } catch {
              // keep watching even if one file fails
            }
          }
          onChange?.();
        })();
      }, 200);
    };
    watcher.on("add", schedule);
    watcher.on("change", schedule);
    watcher.on("unlink", schedule);
    return () => {
      if (timer) clearTimeout(timer);
      void watcher.close();
    };
  }

  // ------------------------------------------------------------------- misc

  stats(): VaultStats {
    const concepts = (
      this.#db.prepare("SELECT COUNT(*) AS n FROM concepts").get() as { n: number }
    ).n;
    const edgeCount = (
      this.#db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }
    ).n;
    const products = (
      this.#db
        .prepare(
          "SELECT DISTINCT product FROM concepts WHERE product IS NOT NULL ORDER BY product",
        )
        .all() as { product: string }[]
    ).map((r) => r.product);
    const tagSet = new Set<string>();
    for (const row of this.#db.prepare("SELECT tags FROM concepts").all() as { tags: string }[]) {
      for (const tag of JSON.parse(row.tags) as string[]) tagSet.add(tag);
    }
    const byType: Record<string, number> = {};
    for (const row of this.#db
      .prepare("SELECT type, COUNT(*) AS n FROM concepts GROUP BY type ORDER BY type")
      .all() as { type: string; n: number }[]) {
      byType[row.type] = row.n;
    }
    return {
      concepts,
      edges: edgeCount,
      products,
      tags: [...tagSet].sort(),
      byType,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
