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
  advanceSweep,
  assembleContext,
  bfsRelated,
  cosineSim,
  decideEntry,
  diaryEntry,
  dreamId,
  dreamOptionsFromSettings,
  extractWikiLinks,
  isEmptySweep,
  nextDreamDue,
  normalizeDreamSettings,
  patchDreamSettings,
  packVector,
  planDeep,
  renderDiaryEntry,
  rrfFuse,
  selectProposals,
  slugify,
  startSweep,
  TASK_COMPLETE_REMINDER,
  unpackVector,
} from "@brainz/engine";
import type {
  AnyConceptType,
  Concept,
  ConceptMeta,
  ConceptStatus,
  ConceptType,
  DreamConcept,
  DreamDiaryEntry,
  DreamOptions,
  DreamPhase,
  DreamPlan,
  DreamSettings,
  DreamSettingsPatch,
  DreamSnapshot,
  DreamSweepState,
  DreamTrigger,
  Edge,
  TaskStatus,
  UpsertInput,
} from "@brainz/engine";
import type { ConceptTypeEntry } from "@brainz/contracts";
import { BUILTIN_CONCEPT_TYPES, slugifyTypeKey } from "@brainz/contracts";
import {
  buildGraphPayload,
  compactMeta,
  isClaimStale,
  isEmbedRateLimited,
  keywordScore,
  makeSnippet,
  matchSnippet,
  syntheticFilePath,
  tokenize,
  VAULT_ID_HEADER,
} from "./do-helpers";
import {
  chooseDreamProvider,
  type D1Like,
  type DreamProviderChoice,
  type DreamSpendEnv,
  type DreamSpendSummary,
  type KillSwitch,
} from "./dream-budget";

const SCHEMA_VERSION = 8;
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/**
 * Per-vault embedding rate cap (constraint-embedding-rate-cap): a rolling-hour
 * ceiling on Workers-AI embedding calls, counting BOTH reindex/upsert embeds
 * and semantic-search query embeds. Over the cap the vault skips the embed and
 * degrades to keyword-only search (embeddings: "rate-limited"), recovering
 * automatically once the window clears. Writes and queries never fail.
 */
const EMBED_RATE_LIMIT_PER_HOUR = 1000;
const EMBED_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Embedding availability recorded in DO meta (mirrors contracts EMBEDDING_STATUSES). */
type EmbeddingsMeta = "ready" | "unavailable" | "rate-limited";

/**
 * Claim TTL (spec-take-task-atomic / task-lifecycle): a task left `taken` for
 * longer than this — its holder presumably crashed — is treated as reclaimable
 * so take_task can hand it out again and the pile can be fully drained. Fresh
 * claims are unaffected. Surfaced as a computed `staleClaim` flag on listTasks.
 */
const CLAIM_TTL_MS = 30 * 60 * 1000;

/** Dream Diary retention: newest N entries (older rows pruned with their preimages). */
const DREAM_RETENTION = 50;
/** Delay before the alarm continues an in-flight (chunked) sweep. */
const DREAM_CONTINUE_MS = 1000;

/** Minimal Workers AI surface (avoids model-name generics from workers-types). */
interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

interface VaultDOEnv extends DreamSpendEnv {
  AI?: AiBinding;
  /** D1 control plane: dream spend ledger, BYOK keys, kill switch. */
  DB?: D1Like;
}

/** Preimage of one concept a dream wrote: the full prior row (null ⇒ created) + the after-state fingerprint. */
interface DreamPreimage {
  id: string;
  before: ConceptRow | null;
  /** updated_at + hash the dream left behind; both null ⇒ the dream removed the concept. */
  afterUpdatedAt: string | null;
  afterHash: string | null;
}

interface DreamRow {
  [column: string]: string | number | null;
  id: string;
  started_at: string;
  diary_json: string;
  preimage_json: string;
  reverted_at: string | null;
  /** Propose mode: the held sweep state (staged material + accepted proposals) until decided. */
  pending_json: string | null;
}

export interface DreamStatusResult {
  enabled: boolean;
  cadenceHours: number;
  settings: DreamSettings;
  lastDreamAt: string | null;
  nextDreamAt: string | null;
  inFlight: { id: string; phase: DreamPhase; startedAt: string } | null;
  llm: string | null;
  lastEntry?: DreamDiaryEntry;
  /** `workers-ai` | `byok:<provider>` | null — what the next REM step would use. */
  provider?: string | null;
  killSwitch?: KillSwitch;
  /** The vault owner's operator-paid dream spend today. */
  spend?: DreamSpendSummary;
}

export interface DreamRunResult {
  status: "done" | "idle" | "in-progress";
  id: string | null;
  phase?: DreamPhase;
  entry?: DreamDiaryEntry;
}

export interface DreamApplyResult {
  id: string;
  status: "applied" | "nothing-applied" | "rejected" | "dismissed";
  applied: number;
  rejected: number;
  entry: DreamDiaryEntry;
}

export interface DreamRevertResult {
  id: string;
  reverted: boolean;
  restored: number;
  conflicts: string[];
}

interface ConceptRow {
  [column: string]: string | number | null;
  id: string;
  title: string;
  type: string;
  status: string;
  product: string | null;
  tags_json: string;
  code_areas_json: string;
  task_status: string | null;
  taken_by: string | null;
  taken_at: string | null;
  done_at: string | null;
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
    state.blockConcurrencyWhile(async () => {
      this.#initSchema();
      // Dreaming is unattended: make sure an enabled vault always has its alarm.
      if (this.#dreamEnabled() && (await state.storage.getAlarm()) === null) {
        await this.#scheduleDream();
      }
    });
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
        code_areas_json TEXT NOT NULL DEFAULT '[]',
        task_status TEXT,
        taken_by TEXT,
        taken_at TEXT,
        done_at TEXT,
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
      // Rolling-window ledger for the per-vault embedding rate cap: one row per
      // embedding-model call (reindex + query), pruned to a 1h window.
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS embed_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL
      )`);
      this.#sql.exec(`CREATE INDEX IF NOT EXISTS embed_event_at ON embed_event (at)`);
      // Per-vault concept-type registry (Wave TR): types are data, seeded with
      // the 11 built-ins so a fresh vault behaves identically to today.
      this.#createConceptTypeTable();
      this.#createDreamTable();
      if (this.#metaGet("embeddings") === null) this.#metaSet("embeddings", "ready");
    } else {
      // Gated additive migrations for pre-existing vaults. Never edit past
      // branches; append a new one and bump SCHEMA_VERSION.
      if (version < 2) {
        // v1 → v2: code_areas ships (additive column; v1 rows default to []).
        this.#sql.exec(
          `ALTER TABLE concept ADD COLUMN code_areas_json TEXT NOT NULL DEFAULT '[]'`,
        );
      }
      if (version < 3) {
        // v2 → v3: task fields ship (additive, nullable; non-task rows stay null).
        this.#sql.exec(`ALTER TABLE concept ADD COLUMN task_status TEXT`);
        this.#sql.exec(`ALTER TABLE concept ADD COLUMN taken_by TEXT`);
        this.#sql.exec(`ALTER TABLE concept ADD COLUMN taken_at TEXT`);
        this.#sql.exec(`ALTER TABLE concept ADD COLUMN done_at TEXT`);
      }
      if (version < 4) {
        // v3 → v4: embedding rate-cap ledger (additive; starts empty so the
        // window is clear for existing vaults).
        this.#sql.exec(`CREATE TABLE IF NOT EXISTS embed_event (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL
        )`);
        this.#sql.exec(`CREATE INDEX IF NOT EXISTS embed_event_at ON embed_event (at)`);
      }
      if (version < 5) {
        // v4 → v5: per-vault concept-type registry (Wave TR). Additive table,
        // BACKFILLED with the 11 built-ins so existing vaults render identically.
        this.#createConceptTypeTable();
      }
      if (version < 6) {
        // v5 → v6: sync / re-onboard ships `last_synced_at` — a nullable meta
        // KV entry (like `onboarded_at`), not a column. Nothing to ALTER: absent
        // → null (never synced) is the correct default for a pre-sync vault, so
        // a vault onboarded before this migration reads as "never synced" until
        // its next sync (or is stamped at onboard-complete going forward). This
        // gated branch exists to record the version bump; the `meta` table
        // already holds the key with no DDL.
      }
      if (version < 7) {
        // v6 → v7: dreaming — the Dream Diary + preimage table (additive). The
        // dream_* settings are meta KV entries with defaults (on, 24h).
        this.#createDreamTable();
      }
      if (version < 8) {
        // v7 → v8: per-vault dreaming settings (meta `dream_settings`, JSON;
        // absent ⇒ defaults) and propose mode's held sweep state (additive
        // nullable column). v6 vaults just got the column from v7's CREATE.
        const cols = this.#sql.exec<{ name: string }>(`PRAGMA table_info(dream)`).toArray();
        if (!cols.some((c) => c.name === "pending_json")) {
          this.#sql.exec(`ALTER TABLE dream ADD COLUMN pending_json TEXT`);
        }
      }
    }
    // Idempotent seed: if the registry table exists but is empty (fresh vault or
    // just-backfilled), populate the built-ins. Safe to run every init.
    this.#seedBuiltinTypes();
    if (version < SCHEMA_VERSION) this.#metaSet("schema_version", String(SCHEMA_VERSION));
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

  #createDreamTable(): void {
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS dream (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      diary_json TEXT NOT NULL,
      preimage_json TEXT NOT NULL,
      reverted_at TEXT,
      pending_json TEXT
    )`);
  }

  #metaDelete(key: string): void {
    this.#sql.exec(`DELETE FROM meta WHERE key = ?`, key);
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

  // -------------------------------------------------- concept-type registry

  /** Create the per-vault concept-type registry table (idempotent). */
  #createConceptTypeTable(): void {
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS concept_type (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      weight REAL NOT NULL,
      sort_order INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      builtin INTEGER NOT NULL DEFAULT 0
    )`);
  }

  /** Seed the 11 built-in types iff the registry is empty (fresh/backfilled). */
  #seedBuiltinTypes(): void {
    const count = Number(
      this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM concept_type`).one().n,
    );
    if (count > 0) return;
    BUILTIN_CONCEPT_TYPES.forEach((t, i) => {
      this.#sql.exec(
        `INSERT OR IGNORE INTO concept_type (key, label, color, weight, sort_order, hidden, builtin)
         VALUES (?, ?, ?, ?, ?, 0, 1)`,
        t.key,
        t.label,
        t.color,
        t.weight,
        i,
      );
    });
  }

  #typeRowToEntry(row: {
    key: string;
    label: string;
    color: string;
    weight: number;
    sort_order: number;
    hidden: number;
    builtin: number;
  }): ConceptTypeEntry {
    return {
      key: row.key,
      label: row.label,
      color: row.color,
      weight: Number(row.weight),
      order: Number(row.sort_order),
      hidden: Number(row.hidden) !== 0,
      builtin: Number(row.builtin) !== 0,
    };
  }

  /** All registry entries, ordered by sort_order then key. */
  #typeEntries(): ConceptTypeEntry[] {
    return this.#sql
      .exec<{
        key: string;
        label: string;
        color: string;
        weight: number;
        sort_order: number;
        hidden: number;
        builtin: number;
      }>(`SELECT * FROM concept_type ORDER BY sort_order, key`)
      .toArray()
      .map((r) => this.#typeRowToEntry(r));
  }

  #getTypeRow(key: string): ConceptTypeEntry | null {
    const rows = this.#sql
      .exec<{
        key: string;
        label: string;
        color: string;
        weight: number;
        sort_order: number;
        hidden: number;
        builtin: number;
      }>(`SELECT * FROM concept_type WHERE key = ?`, key)
      .toArray();
    return rows.length > 0 ? this.#typeRowToEntry(rows[0]) : null;
  }

  /**
   * Resolve a wire-supplied concept type against the registry. A known key is
   * kept as-is; an unknown/removed type FALLS BACK to "concept" (matching the
   * prior unknown-type behavior). This is the single boundary that makes
   * concept `type` registry-validated instead of a strict enum.
   */
  #resolveType(type: string | undefined | null): string {
    if (!type) return "concept";
    return this.#getTypeRow(type) ? type : "concept";
  }

  listTypes(): { types: ConceptTypeEntry[] } {
    return { types: this.#typeEntries() };
  }

  /** Create a custom type (key slugified). Duplicate key → error. */
  createType(input: {
    key: string;
    label: string;
    color: string;
    weight?: number;
    order?: number;
    hidden?: boolean;
  }): { type: ConceptTypeEntry } {
    const key = slugifyTypeKey(input.key);
    if (!key) throw new Error(`could not derive a type key from ${JSON.stringify(input.key)}`);
    if (this.#getTypeRow(key)) throw new Error(`type "${key}" already exists`);
    const label = input.label?.trim() || key;
    const color = input.color?.trim();
    if (!color) throw new Error("createType requires a color");
    const weight = input.weight ?? 40;
    const maxOrder = Number(
      this.#sql
        .exec<{ n: number | null }>(`SELECT MAX(sort_order) AS n FROM concept_type`)
        .one().n ?? -1,
    );
    const order = input.order ?? maxOrder + 1;
    const hidden = input.hidden ? 1 : 0;
    this.#sql.exec(
      `INSERT INTO concept_type (key, label, color, weight, sort_order, hidden, builtin)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      key,
      label,
      color,
      weight,
      order,
      hidden,
    );
    const saved = this.#getTypeRow(key);
    if (!saved) throw new Error(`failed to create type: ${key}`);
    return { type: saved };
  }

  /** Update any type (built-in or custom): label/color/weight/order/hidden. */
  updateType(
    key: string,
    patch: {
      label?: string;
      color?: string;
      weight?: number;
      order?: number;
      hidden?: boolean;
    },
  ): { type: ConceptTypeEntry } {
    const existing = this.#getTypeRow(key);
    if (!existing) throw new NotFoundError(`no type with key "${key}"`);
    const label = patch.label !== undefined ? patch.label.trim() || existing.label : existing.label;
    const color = patch.color !== undefined ? patch.color.trim() || existing.color : existing.color;
    const weight = patch.weight !== undefined ? patch.weight : existing.weight;
    const order = patch.order !== undefined ? patch.order : existing.order;
    const hidden = patch.hidden !== undefined ? (patch.hidden ? 1 : 0) : existing.hidden ? 1 : 0;
    this.#sql.exec(
      `UPDATE concept_type SET label = ?, color = ?, weight = ?, sort_order = ?, hidden = ? WHERE key = ?`,
      label,
      color,
      weight,
      order,
      hidden,
      key,
    );
    const saved = this.#getTypeRow(key);
    if (!saved) throw new Error(`failed to update type: ${key}`);
    return { type: saved };
  }

  /**
   * Delete a CUSTOM type. Built-ins can't be hard-deleted (hide them instead).
   * Blocked while any concept still carries the type — the caller must reassign
   * those concepts first (or hide the type).
   */
  deleteType(key: string): { ok: true; deleted: boolean } {
    const existing = this.#getTypeRow(key);
    if (!existing) return { ok: true, deleted: false };
    if (existing.builtin) {
      throw new Error(`type "${key}" is built-in — hide it instead of deleting`);
    }
    const inUse = Number(
      this.#sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM concept WHERE type = ?`, key)
        .one().n,
    );
    if (inUse > 0) {
      throw new Error(
        `type "${key}" is used by ${inUse} concept${inUse === 1 ? "" : "s"} — reassign them before deleting`,
      );
    }
    this.#sql.exec(`DELETE FROM concept_type WHERE key = ?`, key);
    return { ok: true, deleted: true };
  }

  // ------------------------------------------------------------------- fetch

  /** POST /<method> with a JSON args body; responses are JSON. */
  async fetch(request: Request): Promise<Response> {
    const method = new URL(request.url).pathname.replace(/^\//, "");
    const vaultId = request.headers.get(VAULT_ID_HEADER);
    if (vaultId && this.#metaGet("vault_id") !== vaultId) this.#metaSet("vault_id", vaultId);
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
        case "listTasks":
          return json(this.listTasks(args as { taskStatus?: TaskStatus; domain?: string }));
        case "takeTask":
          return json(await this.takeTask(args as { id?: string; takenBy?: string }));
        case "completeTask":
          return json(await this.completeTask(args as { id: string; outcome: string }));
        case "reopenTask":
          return json(this.reopenTask(args as { id: string }));
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
        case "listTypes":
          return json(this.listTypes());
        case "createType":
          return json(
            this.createType(
              args as {
                key: string;
                label: string;
                color: string;
                weight?: number;
                order?: number;
                hidden?: boolean;
              },
            ),
          );
        case "updateType":
          return json(
            this.updateType(String(args.key ?? ""), args as {
              label?: string;
              color?: string;
              weight?: number;
              order?: number;
              hidden?: boolean;
            }),
          );
        case "deleteType":
          return json(this.deleteType(String(args.key ?? "")));
        case "onboarding":
          return json(this.onboarding());
        case "setOnboardedAt":
          return json(this.setOnboardedAt(String(args.onboardedAt ?? "")));
        case "syncState":
          return json(this.syncState());
        case "setLastSyncedAt":
          return json(this.setLastSyncedAt(String(args.lastSyncedAt ?? "")));
        case "link":
          return json(await this.link(args as { from: string; to: string; relation?: string }));
        case "dreamStatus":
          return json(await this.dreamStatus());
        case "dreamRun":
          return json(await this.dreamRun());
        case "dreamDiary":
          return json(this.dreamDiary(Number(args.limit ?? 10)));
        case "dreamRevert":
          return json(await this.dreamRevert(String(args.id ?? "")));
        case "dreamConfigure":
          return json(await this.dreamConfigure(args as DreamSettingsPatch));
        case "dreamApply":
          return json(
            await this.dreamApply(
              String(args.id ?? ""),
              Array.isArray(args.proposals) ? (args.proposals as number[]) : undefined,
            ),
          );
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
    // Registry-based type validation (Wave TR): the incoming type must resolve
    // to a key in this vault's concept-type registry; an unknown/removed type
    // falls back to "concept" (matching prior unknown-type behavior). Existing
    // rows keep their stored type when no new type is supplied.
    const requestedType = input.type ?? existing?.type ?? "concept";
    const type: AnyConceptType = this.#resolveType(requestedType);
    const status: ConceptStatus =
      input.status ?? (existing?.status as ConceptStatus | undefined) ?? "active";
    const product =
      input.product !== undefined ? input.product : (existing?.product ?? undefined);
    const tags =
      input.tags !== undefined ? input.tags : existing ? (JSON.parse(existing.tags_json) as string[]) : [];
    const codeAreas =
      input.codeAreas !== undefined
        ? input.codeAreas
        : existing
          ? (JSON.parse(existing.code_areas_json) as string[])
          : [];
    const relations =
      input.relations !== undefined
        ? input.relations
        : existing
          ? (JSON.parse(existing.relations_json) as Record<string, string[]>)
          : {};
    const taskStatus =
      input.taskStatus !== undefined ? input.taskStatus : (existing?.task_status ?? null);
    const takenBy = input.takenBy !== undefined ? input.takenBy : (existing?.taken_by ?? null);
    const takenAt = input.takenAt !== undefined ? input.takenAt : (existing?.taken_at ?? null);
    const doneAt = input.doneAt !== undefined ? input.doneAt : (existing?.done_at ?? null);
    const body = input.body.endsWith("\n") ? input.body : `${input.body}\n`;
    const createdAt = existing?.created_at ?? now;
    const hash = await sha256Hex(`${title}\n\n${body}`);

    this.#sql.exec(
      `INSERT INTO concept (id, title, type, status, product, tags_json, code_areas_json, task_status, taken_by, taken_at, done_at, relations_json, body, hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, type = excluded.type, status = excluded.status,
         product = excluded.product, tags_json = excluded.tags_json,
         code_areas_json = excluded.code_areas_json,
         task_status = excluded.task_status, taken_by = excluded.taken_by,
         taken_at = excluded.taken_at, done_at = excluded.done_at,
         relations_json = excluded.relations_json, body = excluded.body,
         hash = excluded.hash, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      id,
      title,
      type,
      status,
      product ?? null,
      JSON.stringify(tags),
      JSON.stringify(codeAreas),
      taskStatus,
      takenBy,
      takenAt,
      doneAt,
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
    // FTS first: its rowid is the concept row's, which is gone after the DELETE.
    if (this.#fts) this.#sql.exec(`DELETE FROM concept_fts WHERE rowid = ?`, this.#rowidOf(id));
    this.#sql.exec(`DELETE FROM concept WHERE id = ?`, id);
    this.#sql.exec(`DELETE FROM edge WHERE from_id = ?`, id);
    this.#sql.exec(`DELETE FROM embedding WHERE concept_id = ?`, id);
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
    await this.#state.storage.deleteAlarm();
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

  #setEmbeddings(status: EmbeddingsMeta): void {
    this.#metaSet("embeddings", status);
  }

  /** Current embeddings availability from meta (defaults to "unavailable"). */
  #embeddingsMeta(): EmbeddingsMeta {
    const v = this.#metaGet("embeddings");
    return v === "ready" || v === "rate-limited" ? v : "unavailable";
  }

  /**
   * True when the vault has hit its rolling-hour embed cap and the NEXT call
   * must be skipped. Prunes events outside the window first, then counts.
   * Deterministic given `now`; called immediately before any AI.run embed.
   */
  #embedRateLimited(now: number): boolean {
    const cutoff = now - EMBED_RATE_WINDOW_MS;
    this.#sql.exec(`DELETE FROM embed_event WHERE at <= ?`, cutoff);
    const timestamps = this.#sql
      .exec<{ at: number }>(`SELECT at FROM embed_event`)
      .toArray()
      .map((r) => Number(r.at));
    return isEmbedRateLimited(timestamps, now, EMBED_RATE_WINDOW_MS, EMBED_RATE_LIMIT_PER_HOUR);
  }

  /** Record one embedding-model call against the rolling window. */
  #recordEmbedCall(now: number): void {
    this.#sql.exec(`INSERT INTO embed_event (at) VALUES (?)`, now);
  }

  async #tryEmbed(id: string, text: string, hash: string): Promise<void> {
    if (!this.#env.AI) {
      this.#setEmbeddings("unavailable");
      return;
    }
    // Over the per-vault rolling-hour cap: skip the embed, degrade to
    // keyword-only. The write proceeds; the concept re-embeds on its next
    // hash change once the window clears.
    if (this.#embedRateLimited(Date.now())) {
      this.#setEmbeddings("rate-limited");
      return;
    }
    try {
      this.#recordEmbedCall(Date.now());
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
      this.#setEmbeddings("ready");
    } catch {
      // Degrade to keyword-only; never fail the write.
      this.#setEmbeddings("unavailable");
    }
  }

  async #embedQuery(query: string): Promise<Float32Array | null> {
    // No AI binding, or embeddings hard-degraded to unavailable → keyword-only.
    if (!this.#env.AI || this.#metaGet("embeddings") === "unavailable") return null;
    // Over the cap: skip the query embed too (query embeds count against the
    // same rolling window), degrade to keyword-only, recover when it clears.
    if (this.#embedRateLimited(Date.now())) {
      this.#setEmbeddings("rate-limited");
      return null;
    }
    try {
      this.#recordEmbedCall(Date.now());
      const result = (await this.#env.AI.run(EMBEDDING_MODEL, { text: [query] })) as {
        data?: number[][];
      };
      const vector = result?.data?.[0];
      if (!Array.isArray(vector) || vector.length === 0) return null;
      // A successful query embed clears a prior rate-limited flag.
      if (this.#metaGet("embeddings") === "rate-limited") this.#setEmbeddings("ready");
      return Float32Array.from(vector);
    } catch {
      this.#setEmbeddings("unavailable");
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

  // -------------------------------------------------------------------- tasks

  /** Task-type concepts, oldest-first (createdAt then id). A task with no
   * task_status is treated as "open". Optionally filtered by status / part_of domain.
   * Each `taken` task carries a computed `staleClaim` flag (claim past the TTL). */
  listTasks(filter: { taskStatus?: TaskStatus; domain?: string } = {}): {
    count: number;
    tasks: (ReturnType<typeof compactMeta> & { staleClaim?: boolean })[];
  } {
    const now = Date.now();
    const rows = this.#sql
      .exec<ConceptRow>(`SELECT * FROM concept WHERE type = 'task'`)
      .toArray();
    const edges = this.#edges();
    const domainOf = (id: string): string[] =>
      edges.filter((e) => e.from === id && e.relation === "part_of").map((e) => e.to);
    const tasks = rows
      .map((r) => this.#rowToMeta(r))
      .filter((m) => {
        const status = m.taskStatus ?? "open";
        if (filter.taskStatus && status !== filter.taskStatus) return false;
        if (filter.domain && !domainOf(m.id).includes(filter.domain)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
      )
      .map((m) => {
        const compact = compactMeta(m);
        const stale = m.taskStatus === "taken" && isClaimStale(m.takenAt, now, CLAIM_TTL_MS);
        return stale ? { ...compact, staleClaim: true } : compact;
      });
    return { count: tasks.length, tasks };
  }

  /**
   * Atomically claim a task (DO storage is single-threaded, so this
   * read-modify-write is race-free). With no id, claims THE next open task
   * (oldest open by createdAt then id). Returns the task plus a get_context-grade
   * bundle for its part_of domain + realizes / governed_by neighbors.
   */
  async takeTask(args: { id?: string; takenBy?: string } = {}): Promise<{
    task: ReturnType<typeof compactMeta> & { createdAt?: string; updatedAt?: string };
    body: string;
    context: {
      markdown: string;
      included: string[];
      truncated: boolean;
      approxTokens: number;
    };
  }> {
    const now = Date.now();
    let row: ConceptRow | null;
    if (args.id) {
      row = this.#getRow(args.id);
      if (!row) throw new NotFoundError(`no task with id "${args.id}"`);
      if (row.type !== "task") throw new Error(`concept "${args.id}" is not a task`);
      const status = (row.task_status as TaskStatus | null) ?? "open";
      // Open is always claimable; a `taken` task past the claim TTL is a stale
      // claim (holder likely crashed) and may be reclaimed. `done` never is.
      const stale = status === "taken" && isClaimStale(row.taken_at, now, CLAIM_TTL_MS);
      if (status !== "open" && !stale) {
        throw new Error(`task "${args.id}" is already ${status}` + (row.taken_by ? ` (by ${row.taken_by})` : ""));
      }
    } else {
      // Next claimable task: oldest by createdAt then id, where claimable =
      // open OR a `taken` claim older than the TTL (stale — reclaimable).
      const claimable = this.#sql
        .exec<ConceptRow>(`SELECT * FROM concept WHERE type = 'task'`)
        .toArray()
        .filter((r) => {
          const status = (r.task_status as TaskStatus | null) ?? "open";
          if (status === "open") return true;
          return status === "taken" && isClaimStale(r.taken_at, now, CLAIM_TTL_MS);
        })
        .sort(
          (a, b) =>
            (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
        );
      if (claimable.length === 0) throw new Error("no open tasks to take");
      row = claimable[0];
    }

    const takenBy = args.takenBy?.trim() || "an agent";
    const takenAt = new Date().toISOString();
    this.#sql.exec(
      `UPDATE concept SET task_status = 'taken', taken_by = ?, taken_at = ?, updated_at = ? WHERE id = ?`,
      takenBy,
      takenAt,
      takenAt,
      row.id,
    );

    const claimed = this.#getRow(row.id);
    if (!claimed) throw new Error(`failed to claim task: ${row.id}`);

    // Assemble a briefing: the task itself + its part_of domain + the concepts
    // it realizes / is governed_by (their neighbors expand one hop).
    const seedIds = [claimed.id];
    const relations = JSON.parse(claimed.relations_json) as Record<string, string[]>;
    for (const rel of ["part_of", "realizes", "governed_by"]) {
      for (const target of relations[rel] ?? []) seedIds.push(target);
    }
    const context = this.#assemble(seedIds, 1, 4000);

    const meta = this.#rowToMeta(claimed);
    return {
      task: {
        ...compactMeta(meta),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
      },
      body: claimed.body,
      context,
    };
  }

  /** Mark a task done: set task_status=done + done_at, append the outcome to the body. */
  async completeTask(args: { id: string; outcome: string }): Promise<{
    task: ReturnType<typeof compactMeta> & { createdAt?: string; updatedAt?: string };
    reminder: string;
  }> {
    const row = this.#getRow(args.id);
    if (!row) throw new NotFoundError(`no task with id "${args.id}"`);
    if (row.type !== "task") throw new Error(`concept "${args.id}" is not a task`);
    const outcome = args.outcome?.trim();
    if (!outcome) throw new Error("complete_task requires a non-empty `outcome`");

    const doneAt = new Date().toISOString();
    const base = row.body.endsWith("\n") ? row.body.replace(/\n+$/, "\n") : `${row.body}\n`;
    const body = `${base}\n## Outcome\n\n${outcome}\n`;
    // Re-upsert through upsertConcept so edges/fts/hash stay consistent.
    await this.upsertConcept({
      id: row.id,
      title: row.title,
      body,
      type: "task",
      status: row.status as ConceptStatus,
      product: row.product ?? undefined,
      tags: JSON.parse(row.tags_json) as string[],
      codeAreas: JSON.parse(row.code_areas_json) as string[],
      relations: JSON.parse(row.relations_json) as Record<string, string[]>,
      taskStatus: "done",
      doneAt,
    });
    const saved = this.#getRow(row.id);
    if (!saved) throw new Error(`failed to complete task: ${row.id}`);
    const meta = this.#rowToMeta(saved);
    return {
      task: {
        ...compactMeta(meta),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
      },
      reminder: TASK_COMPLETE_REMINDER,
    };
  }

  /** Reopen a task: back to open, clear takenBy/takenAt (board "move to Open"). */
  reopenTask(args: { id: string }): {
    task: ReturnType<typeof compactMeta> & { createdAt?: string; updatedAt?: string };
  } {
    const row = this.#getRow(args.id);
    if (!row) throw new NotFoundError(`no task with id "${args.id}"`);
    if (row.type !== "task") throw new Error(`concept "${args.id}" is not a task`);
    const now = new Date().toISOString();
    this.#sql.exec(
      `UPDATE concept SET task_status = 'open', taken_by = NULL, taken_at = NULL, done_at = NULL, updated_at = ? WHERE id = ?`,
      now,
      args.id,
    );
    const saved = this.#getRow(args.id);
    if (!saved) throw new Error(`failed to reopen task: ${args.id}`);
    const meta = this.#rowToMeta(saved);
    return {
      task: {
        ...compactMeta(meta),
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
      },
    };
  }

  /** Assemble a context bundle for explicit seed ids (reuses engine assembleContext). */
  #assemble(
    seedIds: string[],
    depth: number,
    tokenBudget: number,
  ): { markdown: string; included: string[]; truncated: boolean; approxTokens: number } {
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
      { depth, tokenBudget },
    );
    return {
      markdown: bundle.markdown,
      included: bundle.included.map((c) => c.id),
      truncated: bundle.truncated,
      approxTokens: bundle.approxTokens,
    };
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

  graph(): ReturnType<typeof buildGraphPayload> & { types: ConceptTypeEntry[] } {
    const metas = this.#sql
      .exec<ConceptRow>(`SELECT * FROM concept ORDER BY id`)
      .toArray()
      .map((r) => this.#rowToMeta(r));
    // Carry the vault's type registry so the client renders custom types' chips/
    // colors and drives the semantic-zoom LOD + node sizing from vault weights.
    return { ...buildGraphPayload(metas, this.#edges()), types: this.#typeEntries() };
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

  // -------------------------------------------------------------- onboarding

  /** Onboarded state, mirrored from the D1 control-plane column into DO meta. */
  onboarding(): { onboardedAt: string | null } {
    return { onboardedAt: this.#metaGet("onboarded_at") };
  }

  /** Record onboarding completion (ISO timestamp) in DO meta. */
  setOnboardedAt(onboardedAt: string): { ok: true; onboardedAt: string } {
    if (!onboardedAt) throw new Error("setOnboardedAt requires an ISO timestamp");
    this.#metaSet("onboarded_at", onboardedAt);
    return { ok: true, onboardedAt };
  }

  // --------------------------------------------------------------------- sync

  /** Last sync point (ISO), mirrored to the D1 control plane. Null → never synced. */
  syncState(): { lastSyncedAt: string | null } {
    return { lastSyncedAt: this.#metaGet("last_synced_at") };
  }

  /**
   * Record a sync point (ISO timestamp) in DO meta. Set at onboard-complete
   * (the initial sync baseline) and again on every `sync {complete}`.
   */
  setLastSyncedAt(lastSyncedAt: string): { ok: true; lastSyncedAt: string } {
    if (!lastSyncedAt) throw new Error("setLastSyncedAt requires an ISO timestamp");
    this.#metaSet("last_synced_at", lastSyncedAt);
    return { ok: true, lastSyncedAt };
  }

  stats(): {
    concepts: number;
    edges: number;
    products: string[];
    tags: string[];
    byType: Record<string, number>;
    onboarded: boolean;
    openTasks: number;
    embeddings: EmbeddingsMeta;
    keywordIndex: "fts5" | "like";
    lastDreamAt: string | null;
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
    const openTasks = Number(
      this.#sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM concept WHERE type = 'task' AND (task_status IS NULL OR task_status = 'open')`,
        )
        .one().n,
    );
    return {
      concepts,
      edges,
      products,
      tags: [...tagSet].sort(),
      byType,
      onboarded: this.#metaGet("onboarded_at") !== null,
      openTasks,
      embeddings: this.#embeddingsMeta(),
      keywordIndex: this.#fts ? "fts5" : "like",
      lastDreamAt: this.#metaGet("last_dream_at"),
    };
  }

  // ----------------------------------------------------------------- dreaming

  /** Test seam: override engine dream options (thresholds, batch sizes) on top of the vault's settings. */
  dreamOptions: Partial<DreamOptions> = {};

  #dreamEnabled(): boolean {
    return this.#metaGet("dream_enabled") !== "false";
  }

  /**
   * The vault's dreaming settings: `dream_enabled` / `dream_cadence_hours`
   * (kept from v7) plus the rest in `dream_settings` JSON, clamped to bounds.
   */
  #dreamSettings(): DreamSettings {
    let rest: unknown = {};
    try {
      rest = JSON.parse(this.#metaGet("dream_settings") ?? "{}");
    } catch {
      rest = {};
    }
    const cadence = this.#metaGet("dream_cadence_hours");
    return normalizeDreamSettings({
      ...(rest && typeof rest === "object" ? rest : {}),
      enabled: this.#dreamEnabled(),
      ...(cadence === null ? {} : { cadenceHours: Number(cadence) }),
    });
  }

  #dreamEngineOptions(settings = this.#dreamSettings()): Partial<DreamOptions> {
    return { ...dreamOptionsFromSettings(settings), ...this.dreamOptions };
  }

  /** Test seam: the fetch BYOK providers use. */
  dreamFetch: typeof fetch | undefined = undefined;

  /** The account this vault's dreams bill to (its owner), or null when unknown. */
  async #dreamOwner(): Promise<string | null> {
    const db = this.#env.DB;
    const vaultId = this.#metaGet("vault_id") ?? (this.#state.id as { name?: string } | undefined)?.name;
    if (!db || !vaultId) return null;
    const row = await db
      .prepare(`SELECT owner_id FROM vault WHERE id = ?`)
      .bind(vaultId)
      .first<{ owner_id: string }>();
    return row?.owner_id ?? null;
  }

  /**
   * Which provider the next REM step may use (spend cap, kill switch, BYOK —
   * see dream-budget.ts). A control-plane failure fails closed: no REM.
   */
  async #dreamChoice(settings = this.#dreamSettings()): Promise<DreamProviderChoice> {
    try {
      return await chooseDreamProvider({
        db: this.#env.DB,
        env: this.#env,
        ai: this.#env.AI,
        ownerId: await this.#dreamOwner(),
        fetchFn: this.dreamFetch,
        preference: settings.llm,
      });
    } catch (err) {
      console.error("dream provider selection failed:", err);
      return {
        llm: null,
        provider: null,
        killSwitch: "off",
        skipReason: "budget: dream spend ledger unavailable",
      };
    }
  }

  #dreamCheckpoint(): DreamSweepState | null {
    const raw = this.#metaGet("dream_checkpoint");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DreamSweepState;
    } catch {
      this.#metaDelete("dream_checkpoint");
      return null;
    }
  }

  /** Arm the alarm: soon while a sweep is in flight, else one cadence after the last dream. */
  async #scheduleDream(): Promise<void> {
    if (!this.#dreamEnabled()) {
      await this.#state.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    if (this.#dreamCheckpoint()) {
      await this.#state.storage.setAlarm(now + DREAM_CONTINUE_MS);
      return;
    }
    const last = this.#metaGet("last_dream_at");
    const due = nextDreamDue(last ? Date.parse(last) : null, now, this.#dreamSettings());
    await this.#state.storage.setAlarm(Math.max(due, now + 60_000));
  }

  /** DO alarm: advance the nightly dream by one bounded step, then re-arm. */
  async alarm(): Promise<void> {
    if (!this.#dreamEnabled()) return;
    try {
      await this.#dreamStep("alarm");
    } catch {
      // A broken sweep must not loop: drop the checkpoint, try again next cadence.
      this.#metaDelete("dream_checkpoint");
    }
    // An empty vault stops waking up; its next access re-arms the alarm.
    const concepts = Number(this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM concept`).one().n);
    if (concepts > 0 || this.#dreamCheckpoint()) await this.#scheduleDream();
  }

  #dreamSnapshot(): DreamSnapshot {
    const concepts: DreamConcept[] = this.#sql
      .exec<ConceptRow>(`SELECT * FROM concept ORDER BY id`)
      .toArray()
      .map((row) => {
        const meta = this.#rowToMeta(row);
        return {
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
          relations: JSON.parse(row.relations_json) as Record<string, string[]>,
          body: row.body,
          ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
          ...(meta.updatedAt !== undefined ? { updatedAt: meta.updatedAt } : {}),
        };
      });
    const vectors = new Map<string, Float32Array>();
    for (const row of this.#sql
      .exec<{ concept_id: string; vector: ArrayBuffer }>(`SELECT concept_id, vector FROM embedding`)
      .toArray()) {
      vectors.set(row.concept_id, unpackVector(row.vector));
    }
    return { concepts, vector: (id) => vectors.get(id) ?? null };
  }

  /**
   * One bounded step of a sweep (DO storage is single-threaded, so a manual
   * run and the alarm never interleave mid-step). Starts a sweep when none is
   * in flight; finishes it (deep + diary) once light and REM are done.
   */
  async #dreamStep(trigger: DreamTrigger): Promise<DreamRunResult> {
    const snapshot = this.#dreamSnapshot();
    let state = this.#dreamCheckpoint();
    if (!state) {
      const now = new Date().toISOString();
      let id = dreamId(now);
      for (let n = 2; this.#sql.exec(`SELECT 1 FROM dream WHERE id = ?`, id).toArray().length > 0; n++) {
        id = `${dreamId(now)}-${n}`;
      }
      // REM owed from a budget/disabled skip: re-stage the same material.
      const backlog = this.#metaGet("dream_backlog_since");
      const since = backlog === null ? this.#metaGet("last_dream_at") : backlog === "*" ? null : backlog;
      state = startSweep({ id, trigger, now, since, snapshot });
      if (isEmptySweep(state)) {
        this.#metaSet("last_dream_at", now);
        return { status: "idle", id: null };
      }
    }
    // Spend controls are checked before every step that could reach REM;
    // light-only mode never picks a provider at all.
    const settings = this.#dreamSettings();
    const choice: Pick<DreamProviderChoice, "llm" | "skipReason" | "meter"> =
      settings.mode === "light-only"
        ? { llm: null, skipReason: "light-only mode" }
        : await this.#dreamChoice(settings);
    const step = { llm: choice.llm, skipReason: choice.skipReason, options: this.#dreamEngineOptions(settings) };
    try {
      // One light batch, or one bounded round of REM calls, per step.
      if (state.phase !== "deep") state = await advanceSweep(state, snapshot, step);
      // Light finishing hands straight to REM within the same step when cheap.
      if (state.phase === "rem") state = await advanceSweep(state, snapshot, step);
    } finally {
      // Record operator-paid spend after the step; the ledger never fails a sweep.
      await choice.meter?.flush().catch((err) => console.error("dream spend not recorded:", err));
    }
    if (state.phase !== "deep") {
      this.#metaSet("dream_checkpoint", JSON.stringify(state));
      return { status: "in-progress", id: state.id, phase: state.phase };
    }
    return { status: "done", id: state.id, entry: await this.#finishDream(state, snapshot, settings) };
  }

  /** Apply a plan's ops, returning the preimage of each touched concept. */
  async #applyDreamPlan(plan: DreamPlan): Promise<DreamPreimage[]> {
    const preimages: DreamPreimage[] = [];
    for (const op of plan.ops) {
      const before = this.#getRow(op.id);
      if (op.after) await this.#writeDreamConcept(op.after);
      else this.deleteConcept(op.id);
      const after = this.#getRow(op.id);
      preimages.push({
        id: op.id,
        before,
        afterUpdatedAt: after?.updated_at ?? null,
        afterHash: after?.hash ?? null,
      });
    }
    return preimages;
  }

  async #finishDream(
    state: DreamSweepState,
    snapshot: DreamSnapshot,
    settings: DreamSettings,
  ): Promise<DreamDiaryEntry> {
    const now = new Date().toISOString();
    const plan =
      state.rem.status === "ok"
        ? planDeep(state, snapshot, { now, options: this.#dreamEngineOptions(settings) })
        : null;
    // Propose mode writes nothing: it keeps the staged material + accepted proposals.
    const proposing = settings.mode === "propose" && plan?.status === "apply";
    const preimages = plan?.status === "apply" && !proposing ? await this.#applyDreamPlan(plan) : [];
    const entry = diaryEntry(state, plan, new Date().toISOString(), { mode: settings.mode });
    const pending = proposing ? { ...state, rem: { ...state.rem, proposals: plan.accepted } } : null;
    this.#sql.exec(
      `INSERT INTO dream (id, started_at, finished_at, trigger, status, diary_json, preimage_json, reverted_at, pending_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      entry.id,
      entry.startedAt,
      entry.finishedAt,
      entry.trigger,
      entry.status,
      JSON.stringify(entry),
      JSON.stringify(preimages),
      pending ? JSON.stringify(pending) : null,
    );
    this.#sql.exec(
      `DELETE FROM dream WHERE id NOT IN (SELECT id FROM dream ORDER BY started_at DESC, id DESC LIMIT ?)`,
      DREAM_RETENTION,
    );
    // The sweep's START is the next baseline, so edits made during it are seen next time.
    this.#metaSet("last_dream_at", state.startedAt);
    // REM skipped by the spend controls stays owed: the next sweep re-stages from the same point.
    if (state.rem.status === "skipped" && /^(budget|disabled):/.test(state.rem.reason ?? "")) {
      this.#metaSet("dream_backlog_since", state.since ?? "*");
    } else {
      this.#metaDelete("dream_backlog_since");
    }
    this.#metaDelete("dream_checkpoint");
    return entry;
  }

  /** Write a planned concept exactly as given (dream-owned timestamps), rebuilding edges/FTS/embedding. */
  async #writeDreamConcept(c: DreamConcept): Promise<void> {
    const body = c.body.endsWith("\n") ? c.body : `${c.body}\n`;
    const hash = await sha256Hex(`${c.title}\n\n${body}`);
    this.#putRow({
      id: c.id,
      title: c.title,
      type: this.#resolveType(c.type),
      status: c.status,
      product: c.product ?? null,
      tags_json: JSON.stringify(c.tags),
      code_areas_json: JSON.stringify(c.codeAreas),
      task_status: c.taskStatus ?? null,
      taken_by: c.takenBy ?? null,
      taken_at: c.takenAt ?? null,
      done_at: c.doneAt ?? null,
      relations_json: JSON.stringify(c.relations),
      body,
      hash,
      created_at: c.createdAt ?? null,
      updated_at: c.updatedAt ?? null,
    });
    await this.#reembedIfStale(c.id);
  }

  /** Upsert a full concept row verbatim and rebuild its derived state (edges, FTS). */
  #putRow(row: ConceptRow): void {
    this.#sql.exec(
      `INSERT INTO concept (id, title, type, status, product, tags_json, code_areas_json, task_status, taken_by, taken_at, done_at, relations_json, body, hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, type = excluded.type, status = excluded.status,
         product = excluded.product, tags_json = excluded.tags_json,
         code_areas_json = excluded.code_areas_json,
         task_status = excluded.task_status, taken_by = excluded.taken_by,
         taken_at = excluded.taken_at, done_at = excluded.done_at,
         relations_json = excluded.relations_json, body = excluded.body,
         hash = excluded.hash, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      row.id,
      row.title,
      row.type,
      row.status,
      row.product,
      row.tags_json,
      row.code_areas_json,
      row.task_status,
      row.taken_by,
      row.taken_at,
      row.done_at,
      row.relations_json,
      row.body,
      row.hash,
      row.created_at,
      row.updated_at,
    );
    this.#rebuildEdges(
      row.id,
      JSON.parse(row.relations_json) as Record<string, string[]>,
      row.body,
    );
    this.#updateFts(row.id, row.title, row.body, JSON.parse(row.tags_json) as string[]);
  }

  async #reembedIfStale(id: string): Promise<void> {
    const row = this.#getRow(id);
    if (!row) return;
    const prev = this.#sql
      .exec<{ hash: string }>(`SELECT hash FROM embedding WHERE concept_id = ?`, id)
      .toArray();
    if (prev.length === 0 || prev[0].hash !== row.hash) {
      await this.#tryEmbed(id, `${row.title}\n\n${row.body}`, row.hash);
    }
  }

  #latestEntry(): DreamDiaryEntry | undefined {
    const rows = this.#sql
      .exec<DreamRow>(`SELECT * FROM dream ORDER BY started_at DESC, id DESC LIMIT 1`)
      .toArray();
    return rows.length > 0 ? (JSON.parse(rows[0].diary_json) as DreamDiaryEntry) : undefined;
  }

  async dreamStatus(): Promise<DreamStatusResult> {
    const settings = this.#dreamSettings();
    const enabled = settings.enabled;
    const alarm = enabled ? await this.#state.storage.getAlarm() : null;
    const flight = this.#dreamCheckpoint();
    const lastEntry = this.#latestEntry();
    const choice = await this.#dreamChoice(settings);
    const lightOnly = settings.mode === "light-only";
    return {
      enabled,
      cadenceHours: settings.cadenceHours,
      settings,
      lastDreamAt: this.#metaGet("last_dream_at"),
      nextDreamAt: alarm === null ? null : new Date(alarm).toISOString(),
      inFlight: flight ? { id: flight.id, phase: flight.phase, startedAt: flight.startedAt } : null,
      // Light-only mode never calls an LLM, whatever would be available.
      llm: lightOnly ? null : (choice.llm?.name ?? null),
      ...(lastEntry ? { lastEntry } : {}),
      provider: lightOnly ? null : choice.provider,
      killSwitch: choice.killSwitch,
      ...(choice.spend ? { spend: choice.spend } : {}),
    };
  }

  /**
   * Dream now: start (or continue) a sweep and advance it as far as one request
   * allows. An unfinished sweep continues on the alarm shortly after.
   */
  async dreamRun(): Promise<DreamRunResult> {
    let result = await this.#dreamStep("manual");
    // A small vault finishes in a few steps; bound the request regardless.
    for (let i = 0; i < 4 && result.status === "in-progress"; i++) {
      result = await this.#dreamStep("manual");
    }
    if (result.status === "in-progress") await this.#state.storage.setAlarm(Date.now() + DREAM_CONTINUE_MS);
    else await this.#scheduleDream();
    return result;
  }

  dreamDiary(limit = 10): { count: number; entries: DreamDiaryEntry[] } {
    const n = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 10));
    const entries = this.#sql
      .exec<DreamRow>(`SELECT * FROM dream ORDER BY started_at DESC, id DESC LIMIT ?`, n)
      .toArray()
      .map((r) => JSON.parse(r.diary_json) as DreamDiaryEntry);
    return { count: entries.length, entries };
  }

  /**
   * Undo one dream from its preimages. Refuses (listing conflicts) when a
   * concept it wrote changed since, so later agent work is never clobbered.
   */
  async dreamRevert(id: string): Promise<DreamRevertResult> {
    const rows = this.#sql.exec<DreamRow>(`SELECT * FROM dream WHERE id = ?`, id).toArray();
    if (rows.length === 0) throw new NotFoundError(`no dream with id "${id}"`);
    const row = rows[0];
    if (row.reverted_at) throw new Error(`dream "${id}" was already reverted`);
    if (row.status === "proposed") {
      throw new Error(`dream "${id}" is still proposed — nothing was written; decide it with apply`);
    }
    const preimages = JSON.parse(row.preimage_json) as DreamPreimage[];
    const conflicts: string[] = [];
    for (const p of preimages) {
      const current = this.#getRow(p.id);
      const unchanged =
        p.afterHash === null
          ? current === null
          : current !== null && current.hash === p.afterHash && current.updated_at === p.afterUpdatedAt;
      if (!unchanged) conflicts.push(p.id);
    }
    if (conflicts.length > 0) return { id, reverted: false, restored: 0, conflicts };
    for (const p of [...preimages].reverse()) {
      if (p.before === null) this.deleteConcept(p.id);
      else {
        this.#putRow(p.before);
        await this.#reembedIfStale(p.id);
      }
    }
    const revertedAt = new Date().toISOString();
    const entry = { ...(JSON.parse(row.diary_json) as DreamDiaryEntry), status: "reverted" as const, revertedAt };
    entry.markdown = renderDiaryEntry(entry);
    this.#sql.exec(
      `UPDATE dream SET status = 'reverted', reverted_at = ?, diary_json = ? WHERE id = ?`,
      revertedAt,
      JSON.stringify(entry),
      id,
    );
    return { id, reverted: true, restored: preimages.length, conflicts: [] };
  }

  /**
   * Decide a `proposed` dream: approve `proposals` (positions; omitted ⇒ all),
   * reject the rest. Approved ones are re-gated against the vault as it is
   * NOW and applied with preimages, so the dream stays revertible.
   */
  async dreamApply(id: string, proposals?: number[]): Promise<DreamApplyResult> {
    const rows = this.#sql.exec<DreamRow>(`SELECT * FROM dream WHERE id = ?`, id).toArray();
    if (rows.length === 0) throw new NotFoundError(`no dream with id "${id}"`);
    const row = rows[0];
    if (row.status !== "proposed" || !row.pending_json) {
      throw new Error(`dream "${id}" has no pending proposals (status ${row.status})`);
    }
    const entry = JSON.parse(row.diary_json) as DreamDiaryEntry;
    const pending = JSON.parse(row.pending_json) as DreamSweepState;
    const all = (entry.proposals ?? []).map((p) => p.n);
    const selected = proposals === undefined ? all : all.filter((n) => proposals.includes(n));
    const now = new Date().toISOString();
    let plan: DreamPlan | null = null;
    let preimages: DreamPreimage[] = [];
    if (selected.length > 0) {
      const state = { ...pending, rem: { ...pending.rem, proposals: selectProposals(pending.rem.proposals, selected) } };
      plan = planDeep(state, this.#dreamSnapshot(), { now, options: this.#dreamEngineOptions() });
      if (plan.status === "apply") preimages = await this.#applyDreamPlan(plan);
    }
    const decided = decideEntry(entry, plan, selected, now);
    this.#sql.exec(
      `UPDATE dream SET status = ?, diary_json = ?, preimage_json = ?, pending_json = NULL WHERE id = ?`,
      decided.status,
      JSON.stringify(decided),
      JSON.stringify(preimages),
      id,
    );
    const applied = plan?.status === "apply" ? plan.applied.length : 0;
    return {
      id,
      status: decided.status as DreamApplyResult["status"],
      applied,
      rejected: all.length - applied,
      entry: decided,
    };
  }

  async dreamConfigure(patch: DreamSettingsPatch): Promise<DreamStatusResult> {
    const next = patchDreamSettings(this.#dreamSettings(), patch);
    const { enabled, cadenceHours, ...rest } = next;
    this.#metaSet("dream_enabled", enabled ? "true" : "false");
    this.#metaSet("dream_cadence_hours", String(cadenceHours));
    this.#metaSet("dream_settings", JSON.stringify(rest));
    // Turning dreaming off also abandons any sweep in flight.
    if (!this.#dreamEnabled()) this.#metaDelete("dream_checkpoint");
    await this.#scheduleDream();
    return this.dreamStatus();
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
    const codeAreas = JSON.parse(row.code_areas_json ?? "[]") as string[];
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
  type: AnyConceptType;
  status: ConceptStatus;
  product?: string;
  tags: string[];
  codeAreas?: string[];
  taskStatus?: "open" | "taken" | "done";
  takenBy?: string;
  takenAt?: string;
  doneAt?: string;
  createdAt?: string;
  updatedAt?: string;
  body: string;
}

export interface WireNeighbor {
  id: string;
  title: string;
  type: AnyConceptType;
  status: ConceptStatus;
  product?: string;
  tags: string[];
  codeAreas?: string[];
  relation: string;
  direction: "out" | "in";
}

export interface WireHit {
  id: string;
  title: string;
  type: AnyConceptType;
  score: number;
  snippet: string;
}

export interface WireRelated {
  id: string;
  title: string;
  type: AnyConceptType;
  status: ConceptStatus;
  product?: string;
  tags: string[];
  codeAreas?: string[];
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
