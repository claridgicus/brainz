/**
 * Dreaming spend controls (SPEC-CLOUD "Dreaming → Spend controls"): the
 * per-account daily cap on operator-paid Workers AI, the global kill switch,
 * and bring-your-own LLM keys. All state is in the D1 control plane — vault
 * DOs are per vault, the cap is per account (the vault's owner).
 *
 * Helpers here take a minimal D1 handle so both the VaultDO (its own `DB`
 * binding) and the REST routes share them, and tests can back them with
 * better-sqlite3.
 */
import type { DreamLlm } from "@brainz/engine";
import {
  anthropicDreamLlm,
  DREAM_LLM_PRICE_USD_PER_M,
  type AiRunner,
  type DreamLlmUsage,
  failingDreamLlm,
  openAiCompatibleDreamLlm,
  workersAiDreamLlm,
} from "./dream-llm";

/** The subset of D1 this module uses (D1Database satisfies it). */
export interface D1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

/** Bindings/vars that steer dream spend. */
export interface DreamSpendEnv {
  /** USD per account per UTC day for operator-paid dreams (wrangler var, default 1). */
  DREAM_DAILY_USD_PER_ACCOUNT?: string;
  /** Kill-switch override: `1`/`true`/`workers-ai` or `all`. */
  DREAMING_AI_DISABLED?: string;
  /** Secret the BYOK AES-GCM key is derived from. */
  BYOK_ENCRYPTION_KEY?: string;
}

export const DEFAULT_DAILY_USD_PER_ACCOUNT = 1;

// ------------------------------------------------------------- kill switch

/** off: normal · workers-ai: no operator-paid calls (BYOK still runs) · all: no dream LLM calls. */
export type KillSwitch = "off" | "workers-ai" | "all";

/** D1 `control_flag` key of the kill switch. */
export const KILL_SWITCH_FLAG = "dreaming_kill_switch";

const KILL_RANK: Record<KillSwitch, number> = { off: 0, "workers-ai": 1, all: 2 };

export function parseKillSwitch(value: string | null | undefined): KillSwitch {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "all") return "all";
  if (["1", "true", "yes", "on", "workers-ai"].includes(v)) return "workers-ai";
  return "off";
}

/** The D1 flag and the wrangler var override: the stronger one wins. */
export function strongerKillSwitch(a: KillSwitch, b: KillSwitch): KillSwitch {
  return KILL_RANK[a] >= KILL_RANK[b] ? a : b;
}

export async function readKillSwitch(db: D1Like | undefined, env: DreamSpendEnv): Promise<KillSwitch> {
  const fromVar = parseKillSwitch(env.DREAMING_AI_DISABLED);
  if (!db || fromVar === "all") return fromVar;
  const row = await db
    .prepare(`SELECT value FROM control_flag WHERE key = ?`)
    .bind(KILL_SWITCH_FLAG)
    .first<{ value: string }>();
  return strongerKillSwitch(fromVar, parseKillSwitch(row?.value));
}

// ------------------------------------------------------------------- budget

export function dailyCapUsd(env: DreamSpendEnv): number {
  const raw = env.DREAM_DAILY_USD_PER_ACCOUNT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_USD_PER_ACCOUNT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_USD_PER_ACCOUNT;
}

/** The ledger's day key: UTC `YYYY-MM-DD`. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** USD cost of one Workers AI call at the model's published per-M-token price. */
export function dreamCostUsd(
  usage: DreamLlmUsage,
  price: { input: number; output: number } = DREAM_LLM_PRICE_USD_PER_M,
): number {
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

const toMicros = (usd: number) => Math.round(usd * 1_000_000);
const fromMicros = (micros: number) => micros / 1_000_000;

export async function spentUsd(db: D1Like, userId: string, day: string): Promise<number> {
  const row = await db
    .prepare(`SELECT usd_micros FROM dream_spend WHERE user_id = ? AND day = ?`)
    .bind(userId, day)
    .first<{ usd_micros: number }>();
  return fromMicros(Number(row?.usd_micros ?? 0));
}

/** Add spend to the (user, day) ledger row. */
export async function recordDreamSpend(
  db: D1Like,
  userId: string,
  day: string,
  usd: number,
  calls: number,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dream_spend (user_id, day, usd_micros, calls, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         usd_micros = usd_micros + excluded.usd_micros,
         calls = calls + excluded.calls,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, day, toMicros(usd), calls, now.getTime())
    .run();
}

export interface DreamSpendSummary {
  day: string;
  usd: number;
  capUsd: number;
  remainingUsd: number;
}

export function spendSummary(day: string, usd: number, capUsd: number): DreamSpendSummary {
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  return { day, usd: round(usd), capUsd, remainingUsd: round(Math.max(0, capUsd - usd)) };
}

export async function vaultOwner(db: D1Like, vaultId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT owner_id FROM vault WHERE id = ?`)
    .bind(vaultId)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? null;
}

// --------------------------------------------------------------------- BYOK

export type ByokProvider = "anthropic" | "openai";

export interface LlmKeyRow {
  user_id: string;
  provider: string;
  ciphertext: string;
  iv: string;
  key_hint: string;
  base_url: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("BYOK_ENCRYPTION_KEY is not configured");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-GCM encrypt (random 12-byte IV; `aad` binds the ciphertext to its owner). */
export async function encryptSecret(
  secret: string,
  plaintext: string,
  aad: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await aesKey(secret),
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: toBase64(new Uint8Array(ct)), iv: toBase64(iv) };
}

/** Inverse of encryptSecret; throws on a wrong secret, wrong owner, or tampering. */
export async function decryptSecret(
  secret: string,
  sealed: { ciphertext: string; iv: string },
  aad: string,
): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: new TextEncoder().encode(aad) },
    await aesKey(secret),
    fromBase64(sealed.ciphertext),
  );
  return new TextDecoder().decode(pt);
}

/** What the UI shows instead of the key: a prefix and the last 4 characters. */
export function keyHint(apiKey: string): string {
  const k = apiKey.trim();
  if (k.length <= 12) return `…${k.slice(-4)}`;
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}

export async function loadLlmKey(db: D1Like, userId: string): Promise<LlmKeyRow | null> {
  return db.prepare(`SELECT * FROM llm_key WHERE user_id = ?`).bind(userId).first<LlmKeyRow>();
}

export async function saveLlmKey(
  db: D1Like,
  secret: string,
  userId: string,
  input: { provider: ByokProvider; apiKey: string; baseUrl?: string | null; model?: string | null },
  now = new Date(),
): Promise<void> {
  const apiKey = input.apiKey.trim();
  const sealed = await encryptSecret(secret, apiKey, userId);
  await db
    .prepare(
      `INSERT INTO llm_key (user_id, provider, ciphertext, iv, key_hint, base_url, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         provider = excluded.provider, ciphertext = excluded.ciphertext, iv = excluded.iv,
         key_hint = excluded.key_hint, base_url = excluded.base_url, model = excluded.model,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      input.provider,
      sealed.ciphertext,
      sealed.iv,
      keyHint(apiKey),
      input.provider === "openai" ? (input.baseUrl ?? null) : null,
      input.model?.trim() || null,
      now.getTime(),
      now.getTime(),
    )
    .run();
}

export async function deleteLlmKey(db: D1Like, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM llm_key WHERE user_id = ?`).bind(userId).run();
}

/**
 * The DreamLlm for a stored key. A key that can't be decrypted or is
 * misconfigured becomes a provider that always fails — REM records
 * `llm-error` and never falls back to Workers AI.
 */
export async function byokDreamLlm(
  row: LlmKeyRow,
  secret: string | undefined,
  fetchFn?: typeof fetch,
): Promise<DreamLlm> {
  const name = `byok:${row.provider}`;
  let apiKey: string;
  try {
    apiKey = await decryptSecret(secret ?? "", row, row.user_id);
  } catch {
    return failingDreamLlm(name, "stored LLM key could not be decrypted — set it again in settings");
  }
  if (row.provider === "anthropic") return anthropicDreamLlm(apiKey, row.model ?? undefined, fetchFn);
  if (row.provider === "openai" && row.base_url && row.model) {
    return openAiCompatibleDreamLlm({ apiKey, baseUrl: row.base_url, model: row.model }, fetchFn);
  }
  return failingDreamLlm(name, `stored LLM key has an unusable provider configuration (${row.provider})`);
}

// ---------------------------------------------------------------- selection

export interface DreamProviderChoice {
  /** The provider for this REM step, or null (REM is skipped with `skipReason`). */
  llm: DreamLlm | null;
  /** `workers-ai` | `byok:<provider>` | null — what status reports. */
  provider: string | null;
  skipReason?: string;
  killSwitch: KillSwitch;
  /** The owner's operator-paid spend today (absent when the owner is unknown). */
  spend?: DreamSpendSummary;
  /** Set when the step runs on Workers AI: add usage here, then `flush()` once after the step. */
  meter?: { usd: number; calls: number; flush(): Promise<void> };
}

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Decide which provider (if any) the next REM step may use — SPEC order:
 * kill switch `all` → owner's BYOK key → kill switch `workers-ai` → no AI
 * binding → daily cap spent → metered Workers AI.
 */
export async function chooseDreamProvider(args: {
  db: D1Like | undefined;
  env: DreamSpendEnv;
  ai: AiRunner | undefined;
  ownerId: string | null;
  now?: Date;
  fetchFn?: typeof fetch;
}): Promise<DreamProviderChoice> {
  const now = args.now ?? new Date();
  const killSwitch = await readKillSwitch(args.db, args.env);
  if (killSwitch === "all") {
    return {
      llm: null,
      provider: null,
      killSwitch,
      skipReason: "disabled: dreaming LLM calls are switched off by the operator",
    };
  }
  if (!args.db || !args.ownerId) {
    return {
      llm: null,
      provider: null,
      killSwitch,
      skipReason: args.ai
        ? "budget: no account to bill this vault's dreams to"
        : "no LLM provider available",
    };
  }
  const db = args.db;
  const ownerId = args.ownerId;
  const day = utcDay(now);
  const cap = dailyCapUsd(args.env);
  const spent = await spentUsd(db, ownerId, day);
  const spend = spendSummary(day, spent, cap);

  const key = await loadLlmKey(db, ownerId);
  if (key) {
    return {
      llm: await byokDreamLlm(key, args.env.BYOK_ENCRYPTION_KEY, args.fetchFn),
      provider: `byok:${key.provider}`,
      killSwitch,
      spend,
    };
  }
  if (killSwitch === "workers-ai") {
    return {
      llm: null,
      provider: null,
      killSwitch,
      spend,
      skipReason: "disabled: operator-paid dreaming is switched off; only an owner-configured LLM key runs REM",
    };
  }
  if (!args.ai) return { llm: null, provider: null, killSwitch, spend, skipReason: "no LLM provider available" };
  if (spent >= cap) {
    return {
      llm: null,
      provider: "workers-ai",
      killSwitch,
      spend,
      skipReason: `budget: today's dream budget is spent (${fmtUsd(spent)} of ${fmtUsd(cap)}); REM retries tomorrow`,
    };
  }
  const meter = {
    usd: 0,
    calls: 0,
    async flush() {
      if (meter.calls === 0) return;
      const { usd, calls } = meter;
      meter.usd = 0;
      meter.calls = 0;
      await recordDreamSpend(db, ownerId, day, usd, calls, now);
    },
  };
  const llm = workersAiDreamLlm(args.ai, undefined, (usage) => {
    meter.usd += dreamCostUsd(usage);
    meter.calls++;
  });
  return { llm, provider: "workers-ai", killSwitch, spend, meter };
}
