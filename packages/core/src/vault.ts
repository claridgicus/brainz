import type DatabaseType from "better-sqlite3";
import {
  advanceSweep,
  assembleContext,
  bfsRelated,
  cosineSim,
  decideEntry,
  diaryEntry,
  dreamId,
  dreamOptionsFromSettings,
  isEmptySweep,
  normalizeDreamSettings,
  patchDreamSettings,
  ONBOARDING_SUMMARY_ID,
  planDeep,
  renderDiaryEntry,
  selectProposals,
  startSweep,
  packVector,
  parseNote,
  readFrontmatter,
  rrfFuse,
  serializeNote,
  slugify,
  unpackVector,
} from "@brainz/engine";
import type {
  Concept,
  ConceptMeta,
  ConceptType,
  ContextBundle,
  ContextOptions,
  DreamConcept,
  DreamDiaryEntry,
  DreamLlm,
  DreamOptions,
  DreamPlan,
  DreamSettings,
  DreamSettingsPatch,
  DreamSnapshot,
  DreamTrigger,
  Edge,
  RelatedNode,
  RelatedOptions,
  SearchHit,
  SearchOptions,
  UpsertInput,
  VaultStats,
} from "@brainz/engine";
import { watch as chokidarWatch } from "chokidar";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { openDb } from "./db.js";
import { serializeDreamConcept, type LocalDreamOp, type LocalDreamRecord } from "./dream.js";
import { createEmbedder, type Embedder, type EmbeddingConfig } from "./embeddings.js";

interface VaultConfig {
  name: string;
  embedding: EmbeddingConfig;
  /** ISO timestamp set when the onboard flow completes; absent → un-onboarded. */
  onboardedAt?: string;
  /** ISO timestamp of the last sync (or initial onboarding); absent → never synced. */
  lastSyncedAt?: string;
  /** Start of the last completed dream sweep; absent → never dreamed. */
  lastDreamAt?: string;
  /** Per-vault dreaming settings (engine DreamSettings; every field optional, defaults apply). */
  dreaming?: Partial<DreamSettings>;
  [key: string]: unknown;
}

interface ConceptRow {
  id: string;
  title: string;
  type: string;
  status: string;
  product: string | null;
  tags: string;
  code_areas: string;
  task_status: string | null;
  taken_by: string | null;
  taken_at: string | null;
  done_at: string | null;
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
    const provider: string = config.embedding?.provider ?? "none";
    if (provider === "openai") {
      // Removed in favor of "cloudflare" (Workers AI). Legacy configs degrade
      // to keyword-only with a hint — never a crash.
      process.stderr.write(
        'brainz: embedding provider "openai" was removed — set "cloudflare" in brainz.config.json (falling back to keyword-only search)\n',
      );
      this.#embeddingStatus = "unavailable";
    } else if (
      provider === "none" ||
      (provider === "cloudflare" &&
        !(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN))
    ) {
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
        embedding: raw.embedding ?? { provider: "cloudflare" },
      };
    } else {
      config = { name: path.basename(abs), embedding: { provider: "cloudflare" } };
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

    const fallbackId = path.basename(filePath).replace(/\.md$/i, "");
    const { meta, body, wikiLinks, relations } = parseNote(raw, { fallbackId });
    const concept: Concept = { ...meta, filePath, body };
    if (existing && existing.id !== concept.id) this.#removeConcept(existing.id);

    this.#db
      .prepare(
        `INSERT INTO concepts (id, title, type, status, product, tags, code_areas, task_status, taken_by, taken_at, done_at, file_path, created_at, updated_at, body, hash)
         VALUES (@id, @title, @type, @status, @product, @tags, @code_areas, @task_status, @taken_by, @taken_at, @done_at, @file_path, @created_at, @updated_at, @body, @hash)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, type = excluded.type, status = excluded.status,
           product = excluded.product, tags = excluded.tags, code_areas = excluded.code_areas,
           task_status = excluded.task_status, taken_by = excluded.taken_by,
           taken_at = excluded.taken_at, done_at = excluded.done_at,
           file_path = excluded.file_path,
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
        code_areas: JSON.stringify(concept.codeAreas ?? []),
        task_status: concept.taskStatus ?? null,
        taken_by: concept.takenBy ?? null,
        taken_at: concept.takenAt ?? null,
        done_at: concept.doneAt ?? null,
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
    for (const to of wikiLinks) {
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
    try {
      // Providers batch internally (Cloudflare chunks texts per request).
      const vectors = await embedder.embed(pending.map((p) => p.text));
      pending.forEach((p, j) => {
        const packed = packVector(vectors[j]);
        // better-sqlite3 requires Buffer for BLOBs; this is a no-copy view.
        insert.run(p.id, Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength), p.hash);
      });
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
      scored.push({ id: row.id, score: cosineSim(queryVec, unpackVector(row.vector)) });
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
    return rrfFuse(a, b, (hit) => hit.concept.id).map((e) => ({ ...e.item, score: e.score }));
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
    const codeAreas = JSON.parse(row.code_areas ?? "[]") as string[];
    if (codeAreas.length > 0) meta.codeAreas = codeAreas;
    if (row.task_status !== null && row.task_status !== undefined)
      meta.taskStatus = row.task_status as ConceptMeta["taskStatus"];
    if (row.taken_by !== null && row.taken_by !== undefined) meta.takenBy = row.taken_by;
    if (row.taken_at !== null && row.taken_at !== undefined) meta.takenAt = row.taken_at;
    if (row.done_at !== null && row.done_at !== undefined) meta.doneAt = row.done_at;
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
    return bfsRelated(this.edges(), id, opts, (nodeId) => this.#getMeta(nodeId));
  }

  // ---------------------------------------------------------------- context

  async assembleContext(opts: ContextOptions): Promise<ContextBundle> {
    if (!opts.query && (!opts.ids || opts.ids.length === 0)) {
      throw new Error("assembleContext requires at least one of `query` or `ids`");
    }

    // Seeds: explicit ids first (given order), then search hits ranked by score.
    const seedIds = [...(opts.ids ?? [])];
    if (opts.query) {
      const hits = await this.search({ query: opts.query, product: opts.product, limit: 10 });
      seedIds.push(...hits.map((hit) => hit.concept.id));
    }

    return assembleContext(
      seedIds,
      {
        edges: this.edges(),
        getMeta: (id) => this.#getMeta(id),
        getConcept: (id) => this.getConcept(id),
      },
      { depth: opts.depth, tokenBudget: opts.tokenBudget, product: opts.product },
    );
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
      data = readFrontmatter(raw).frontmatter; // preserve unknown keys
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
    if (input.codeAreas !== undefined) data.code_areas = input.codeAreas;
    if (input.taskStatus !== undefined) data.task_status = input.taskStatus;
    if (input.takenBy !== undefined) data.taken_by = input.takenBy;
    if (input.takenAt !== undefined) data.taken_at = input.takenAt;
    if (input.doneAt !== undefined) data.done_at = input.doneAt;
    if (input.relations !== undefined) data.relations = input.relations;

    const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, serializeNote(data, body));
    await this.#reindexFile(filePath);

    const saved = this.getConcept(id);
    if (!saved) throw new Error(`failed to index upserted concept: ${id}`);
    return saved;
  }

  /**
   * Delete a concept: remove its markdown file and its index rows (concept,
   * FTS, edges, embedding). Idempotent — deleting an id that doesn't exist is a
   * no-op that returns `{ deleted: false }`.
   */
  async deleteConcept(id: string): Promise<{ deleted: boolean }> {
    const existing = this.getConcept(id);
    if (!existing) return { deleted: false };
    await fsp.rm(existing.filePath, { force: true });
    // File is gone → #reindexFile drops the concept's rows (and its edges/FTS/
    // embedding via #removeConcept).
    await this.#reindexFile(existing.filePath);
    return { deleted: true };
  }

  async link(from: string, to: string, relation = "related_to"): Promise<void> {
    const source = this.getConcept(from);
    if (!source) throw new Error(`unknown concept: ${from}`);

    const raw = await fsp.readFile(source.filePath, "utf8");
    const parsed = readFrontmatter(raw);
    const data = parsed.frontmatter;
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

    await fsp.writeFile(source.filePath, serializeNote(data, parsed.content));
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
    const openTasks = (
      this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM concepts WHERE type = 'task' AND (task_status IS NULL OR task_status = 'open')",
        )
        .get() as { n: number }
    ).n;
    return {
      concepts,
      edges: edgeCount,
      products,
      tags: [...tagSet].sort(),
      byType,
      onboarded: this.onboardedAt !== null,
      openTasks,
    };
  }

  // -------------------------------------------------------------- onboarding

  /** ISO timestamp of onboarding completion (brainz.config.json), or null. */
  get onboardedAt(): string | null {
    return typeof this.#config.onboardedAt === "string" && this.#config.onboardedAt
      ? this.#config.onboardedAt
      : null;
  }

  /** Persist (or clear, with null) the onboarded timestamp in brainz.config.json. */
  async setOnboardedAt(iso: string | null): Promise<void> {
    if (iso === null) delete this.#config.onboardedAt;
    else this.#config.onboardedAt = iso;
    const configPath = path.join(this.dir, "brainz.config.json");
    await fsp.writeFile(configPath, `${JSON.stringify(this.#config, null, 2)}\n`);
  }

  /**
   * Complete onboarding: store the summary as the spec-type
   * `product-onboarding-summary` concept and mark the vault onboarded.
   * Onboarding IS the initial sync point, so last_synced_at is stamped too.
   */
  async completeOnboarding(summary: string): Promise<Concept> {
    const text = summary.trim();
    if (!text) throw new Error("completeOnboarding requires a non-empty summary");
    const saved = await this.upsertConcept({
      id: ONBOARDING_SUMMARY_ID,
      title: "Product onboarding summary",
      type: "spec",
      body: text,
    });
    const now = new Date().toISOString();
    await this.setOnboardedAt(now);
    await this.setLastSyncedAt(now);
    return saved;
  }

  // --------------------------------------------------------------------- sync

  /** ISO timestamp of the last sync (or initial onboarding), or null. */
  get lastSyncedAt(): string | null {
    return typeof this.#config.lastSyncedAt === "string" && this.#config.lastSyncedAt
      ? this.#config.lastSyncedAt
      : null;
  }

  /** Persist (or clear, with null) the last-synced timestamp in brainz.config.json. */
  async setLastSyncedAt(iso: string | null): Promise<void> {
    if (iso === null) delete this.#config.lastSyncedAt;
    else this.#config.lastSyncedAt = iso;
    const configPath = path.join(this.dir, "brainz.config.json");
    await fsp.writeFile(configPath, `${JSON.stringify(this.#config, null, 2)}\n`);
  }

  /**
   * Complete a sync: APPEND the summary to the running sync log on the
   * `product-onboarding-summary` concept (never overwrite) and stamp
   * last_synced_at as the new drift baseline.
   */
  async completeSync(summary: string): Promise<Concept> {
    const text = summary.trim();
    if (!text) throw new Error("completeSync requires a non-empty summary");
    const stamp = new Date().toISOString();
    const existing = this.getConcept(ONBOARDING_SUMMARY_ID);
    const prior = existing?.body?.trimEnd();
    const note = `## Sync ${stamp}\n\n${text}`;
    const body = prior ? `${prior}\n\n${note}` : note;
    const saved = await this.upsertConcept({
      id: ONBOARDING_SUMMARY_ID,
      title: "Product onboarding summary",
      type: "spec",
      body,
    });
    await this.setLastSyncedAt(stamp);
    return saved;
  }

  // ---------------------------------------------------------------- dreaming

  /** Start of the last completed dream sweep (brainz.config.json), or null. */
  get lastDreamAt(): string | null {
    return typeof this.#config.lastDreamAt === "string" && this.#config.lastDreamAt
      ? this.#config.lastDreamAt
      : null;
  }

  /** Every dreaming setting, defaults filled in and clamped to bounds. */
  dreamSettings(): DreamSettings {
    return normalizeDreamSettings(this.#config.dreaming);
  }

  /** The schedule part of the settings: on by default, 24h cadence. */
  dreamConfig(): { enabled: boolean; cadenceHours: number } {
    const { enabled, cadenceHours } = this.dreamSettings();
    return { enabled, cadenceHours };
  }

  /** Merge a settings change into brainz.config.json `dreaming` (nested objects field by field). */
  async configureDreaming(patch: DreamSettingsPatch): Promise<DreamSettings> {
    const next = patchDreamSettings(this.dreamSettings(), patch);
    this.#config.dreaming = next;
    await this.#writeConfig();
    return next;
  }

  async #writeConfig(): Promise<void> {
    const configPath = path.join(this.dir, "brainz.config.json");
    await fsp.writeFile(configPath, `${JSON.stringify(this.#config, null, 2)}\n`);
  }

  #dreamsDir(): string {
    return path.join(this.dir, ".dreams");
  }

  /** Every note as dreaming sees it, plus the raw file behind each id. */
  async #dreamSnapshot(): Promise<{
    snapshot: DreamSnapshot;
    files: Map<string, { filePath: string; raw: string }>;
  }> {
    const files = new Map<string, { filePath: string; raw: string }>();
    const concepts: DreamConcept[] = [];
    for (const meta of this.listConcepts()) {
      let raw: string;
      let mtime: string;
      try {
        raw = await fsp.readFile(meta.filePath, "utf8");
        mtime = (await fsp.stat(meta.filePath)).mtime.toISOString();
      } catch {
        continue;
      }
      const parsed = parseNote(raw, { fallbackId: path.basename(meta.filePath, ".md") });
      files.set(meta.id, { filePath: meta.filePath, raw });
      concepts.push({
        id: meta.id,
        title: meta.title,
        type: meta.type,
        status: meta.status,
        ...(meta.product !== undefined ? { product: meta.product } : {}),
        tags: meta.tags,
        codeAreas: meta.codeAreas ?? [],
        ...(meta.taskStatus !== undefined ? { taskStatus: meta.taskStatus } : {}),
        ...(meta.takenBy !== undefined ? { takenBy: meta.takenBy } : {}),
        ...(meta.takenAt !== undefined ? { takenAt: meta.takenAt } : {}),
        ...(meta.doneAt !== undefined ? { doneAt: meta.doneAt } : {}),
        relations: parsed.relations,
        body: parsed.body,
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        // Local notes rarely carry updatedAt; the file mtime marks recent change.
        updatedAt: meta.updatedAt ?? mtime,
      });
    }
    const vectors = new Map<string, Float32Array>();
    const rows = this.#db.prepare("SELECT id, vector FROM embeddings").all() as {
      id: string;
      vector: Buffer;
    }[];
    for (const row of rows) vectors.set(row.id, unpackVector(row.vector));
    return { snapshot: { concepts, vector: (id) => vectors.get(id) ?? null }, files };
  }

  /**
   * Run one dream sweep to completion (light → REM → deep) with the engine.
   * Without an `llm` only light runs and the diary records REM/deep skipped.
   * An empty sweep (nothing changed since the last dream) writes no entry.
   */
  async dream(
    opts: { llm?: DreamLlm | null; trigger?: DreamTrigger; options?: Partial<DreamOptions> } = {},
  ): Promise<{ status: "done" | "idle"; id: string | null; entry?: DreamDiaryEntry }> {
    const now = new Date().toISOString();
    const { snapshot, files } = await this.#dreamSnapshot();
    let id = dreamId(now);
    for (let n = 2; fs.existsSync(path.join(this.#dreamsDir(), `${id}.json`)); n++) {
      id = `${dreamId(now)}-${n}`;
    }
    let state = startSweep({ id, trigger: opts.trigger ?? "manual", now, since: this.lastDreamAt, snapshot });
    if (isEmptySweep(state)) {
      this.#config.lastDreamAt = now;
      await this.#writeConfig();
      return { status: "idle", id: null };
    }
    const settings = this.dreamSettings();
    const options = { ...dreamOptionsFromSettings(settings), ...(opts.options ?? {}) };
    const lightOnly = settings.mode === "light-only";
    const llm = lightOnly ? null : (opts.llm ?? null);
    const skipReason = lightOnly ? "light-only mode" : undefined;
    while (state.phase !== "deep") {
      state = await advanceSweep(state, snapshot, { llm, options, skipReason });
    }
    const plan = state.rem.status === "ok" ? planDeep(state, snapshot, { now, options }) : null;
    const proposing = settings.mode === "propose" && plan?.status === "apply";

    const ops = plan?.status === "apply" && !proposing ? await this.#applyDreamPlan(plan, files) : [];
    const entry = diaryEntry(state, plan, new Date().toISOString(), { mode: settings.mode });
    const record: LocalDreamRecord = {
      entry,
      ops,
      // Propose mode keeps the staged material + only the accepted proposals for `applyDream`.
      ...(proposing ? { pending: { ...state, rem: { ...state.rem, proposals: plan.accepted } } } : {}),
    };
    await fsp.mkdir(this.#dreamsDir(), { recursive: true });
    await fsp.writeFile(
      path.join(this.#dreamsDir(), `${id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    // The sweep's START is the next baseline, so edits made during it are seen next time.
    this.#config.lastDreamAt = now;
    await this.#writeConfig();
    return { status: "done", id, entry };
  }

  /** Write a plan's ops as markdown and return them with their preimages. */
  async #applyDreamPlan(
    plan: DreamPlan,
    files: Map<string, { filePath: string; raw: string }>,
  ): Promise<LocalDreamOp[]> {
    const ops: LocalDreamOp[] = [];
    for (const op of plan.ops) {
      const prior = files.get(op.id);
      const filePath = prior?.filePath ?? path.join(this.dir, "concepts", `${op.id}.md`);
      const beforeRaw = prior?.raw ?? null;
      const afterRaw = op.after ? serializeDreamConcept(op.after, beforeRaw) : null;
      ops.push({ id: op.id, filePath, beforeRaw, afterRaw });
    }
    await this.#writeDreamFiles(ops.map((o) => ({ filePath: o.filePath, raw: o.afterRaw })));
    return ops;
  }

  /**
   * Decide a `proposed` dream (propose mode): approve `proposals` (positions;
   * omitted ⇒ all), reject the rest. Approved ones are re-gated and re-planned
   * against the vault as it is NOW, then applied with preimages (revertible).
   */
  async applyDream(
    id: string,
    proposals?: number[],
  ): Promise<{
    id: string;
    status: "applied" | "nothing-applied" | "rejected" | "dismissed";
    applied: number;
    rejected: number;
    entry: DreamDiaryEntry;
  }> {
    const record = await this.#readDream(id);
    if (!record) throw new Error(`no dream with id "${id}"`);
    if (record.entry.status !== "proposed" || !record.pending) {
      throw new Error(`dream "${id}" has no pending proposals (status ${record.entry.status})`);
    }
    const all = (record.entry.proposals ?? []).map((p) => p.n);
    const selected = proposals === undefined ? all : all.filter((n) => proposals.includes(n));
    const now = new Date().toISOString();
    let plan: DreamPlan | null = null;
    let ops: LocalDreamOp[] = [];
    if (selected.length > 0) {
      const { snapshot, files } = await this.#dreamSnapshot();
      const pending = record.pending;
      const state = { ...pending, rem: { ...pending.rem, proposals: selectProposals(pending.rem.proposals, selected) } };
      plan = planDeep(state, snapshot, { now, options: dreamOptionsFromSettings(this.dreamSettings()) });
      if (plan.status === "apply") ops = await this.#applyDreamPlan(plan, files);
    }
    const entry = decideEntry(record.entry, plan, selected, now);
    const next: LocalDreamRecord = { entry, ops };
    await fsp.writeFile(path.join(this.#dreamsDir(), `${id}.json`), `${JSON.stringify(next, null, 2)}\n`);
    const applied = plan?.status === "apply" ? plan.applied.length : 0;
    return {
      id,
      status: entry.status as "applied" | "nothing-applied" | "rejected" | "dismissed",
      applied,
      rejected: all.length - applied,
      entry,
    };
  }

  async #writeDreamFiles(writes: { filePath: string; raw: string | null }[]): Promise<void> {
    for (const w of writes) {
      if (w.raw === null) await fsp.rm(w.filePath, { force: true });
      else {
        await fsp.mkdir(path.dirname(w.filePath), { recursive: true });
        await fsp.writeFile(w.filePath, w.raw);
      }
    }
    for (const w of writes) await this.#reindexFile(w.filePath);
  }

  async #readDream(id: string): Promise<LocalDreamRecord | null> {
    if (!/^[a-z0-9-]+$/.test(id)) return null;
    try {
      return JSON.parse(
        await fsp.readFile(path.join(this.#dreamsDir(), `${id}.json`), "utf8"),
      ) as LocalDreamRecord;
    } catch {
      return null;
    }
  }

  /** Dream Diary entries, newest first. */
  async dreamDiary(limit = 10): Promise<DreamDiaryEntry[]> {
    let names: string[];
    try {
      names = (await fsp.readdir(this.#dreamsDir())).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const entries: DreamDiaryEntry[] = [];
    for (const name of names) {
      const record = await this.#readDream(name.slice(0, -5));
      if (record) entries.push(record.entry);
    }
    entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    return entries.slice(0, limit);
  }

  /**
   * Undo one dream byte-for-byte from its preimages. Refuses (listing the
   * conflicts) when any file it wrote has changed since, so later work is
   * never clobbered.
   */
  async revertDream(
    id: string,
  ): Promise<{ id: string; reverted: boolean; restored: number; conflicts: string[] }> {
    const record = await this.#readDream(id);
    if (!record) throw new Error(`no dream with id "${id}"`);
    if (record.entry.revertedAt) throw new Error(`dream "${id}" was already reverted`);
    if (record.entry.status === "proposed") {
      throw new Error(`dream "${id}" is still proposed — nothing was written; decide it with apply`);
    }
    const conflicts: string[] = [];
    for (const op of record.ops) {
      let current: string | null = null;
      try {
        current = await fsp.readFile(op.filePath, "utf8");
      } catch {
        current = null;
      }
      if (current !== op.afterRaw) conflicts.push(op.id);
    }
    if (conflicts.length > 0) return { id, reverted: false, restored: 0, conflicts };
    await this.#writeDreamFiles(
      [...record.ops].reverse().map((op) => ({ filePath: op.filePath, raw: op.beforeRaw })),
    );
    const entry: DreamDiaryEntry = {
      ...record.entry,
      status: "reverted",
      revertedAt: new Date().toISOString(),
    };
    entry.markdown = renderDiaryEntry(entry);
    await fsp.writeFile(
      path.join(this.#dreamsDir(), `${id}.json`),
      `${JSON.stringify({ ...record, entry }, null, 2)}\n`,
    );
    return { id, reverted: true, restored: record.ops.length, conflicts: [] };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
