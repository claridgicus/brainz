import { describe, expect, it } from "vitest";
import {
  byokDreamLlm,
  chooseDreamProvider,
  dailyCapUsd,
  decryptSecret,
  dreamCostUsd,
  encryptSecret,
  keyHint,
  KILL_SWITCH_FLAG,
  loadLlmKey,
  parseKillSwitch,
  readKillSwitch,
  recordDreamSpend,
  saveLlmKey,
  spendSummary,
  spentUsd,
  strongerKillSwitch,
  utcDay,
} from "./dream-budget";
import { DREAM_LLM_PRICE_USD_PER_M, estimateTokens, workersAiDreamLlm } from "./dream-llm";
import { fakeD1, seedOwner } from "./fake-d1.testutil";

const SECRET = "test-byok-secret";
const NOW = new Date("2026-10-28T12:00:00.000Z");

function chatAi(usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    calls: 0,
    async run() {
      this.calls++;
      return { response: '{"merges": []}', ...(usage ? { usage } : {}) };
    },
  };
}

function setKill(d1: ReturnType<typeof fakeD1>, value: string) {
  d1.db
    .prepare(`INSERT INTO control_flag (key, value, updated_at) VALUES (?, ?, 0)`)
    .run(KILL_SWITCH_FLAG, value);
}

describe("cap math", () => {
  it("prices usage at the published per-M rates", () => {
    expect(dreamCostUsd({ inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(DREAM_LLM_PRICE_USD_PER_M.input);
    expect(dreamCostUsd({ inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(DREAM_LLM_PRICE_USD_PER_M.output);
    expect(dreamCostUsd({ inputTokens: 2000, outputTokens: 500 })).toBeCloseTo(
      (2000 * 0.293 + 500 * 2.253) / 1e6,
      12,
    );
  });

  it("defaults the cap to $1 and parses the wrangler var", () => {
    expect(dailyCapUsd({})).toBe(1);
    expect(dailyCapUsd({ DREAM_DAILY_USD_PER_ACCOUNT: "2.5" })).toBe(2.5);
    expect(dailyCapUsd({ DREAM_DAILY_USD_PER_ACCOUNT: "0" })).toBe(0);
    expect(dailyCapUsd({ DREAM_DAILY_USD_PER_ACCOUNT: "lots" })).toBe(1);
    expect(dailyCapUsd({ DREAM_DAILY_USD_PER_ACCOUNT: "-3" })).toBe(1);
  });

  it("keys the ledger by UTC day", () => {
    expect(utcDay(new Date("2026-10-28T23:59:59.999Z"))).toBe("2026-10-28");
    expect(utcDay(new Date("2026-10-29T00:00:00.000Z"))).toBe("2026-10-29");
  });

  it("summarises remaining budget, never below zero", () => {
    expect(spendSummary("d", 0.25, 1)).toEqual({ day: "d", usd: 0.25, capUsd: 1, remainingUsd: 0.75 });
    expect(spendSummary("d", 1.2, 1).remainingUsd).toBe(0);
  });

  it("accumulates spend per (user, day) across every vault's records", async () => {
    const d1 = fakeD1();
    seedOwner(d1, "u1", "v1");
    await recordDreamSpend(d1, "u1", "2026-10-28", 0.1, 3);
    await recordDreamSpend(d1, "u1", "2026-10-28", 0.2, 2); // another vault, same owner
    await recordDreamSpend(d1, "u1", "2026-10-27", 5, 1);
    expect(await spentUsd(d1, "u1", "2026-10-28")).toBeCloseTo(0.3, 9);
    expect(d1.db.prepare(`SELECT calls FROM dream_spend WHERE day = '2026-10-28'`).get()).toEqual({ calls: 5 });
    expect(await spentUsd(d1, "u1", "2026-10-29")).toBe(0);
  });

  it("meters Workers AI calls from binding usage, else chars/4", async () => {
    const seen: { inputTokens: number; outputTokens: number }[] = [];
    await workersAiDreamLlm(chatAi({ prompt_tokens: 100, completion_tokens: 40 }), undefined, (u) => seen.push(u))
      .complete({ system: "s", user: "u", maxTokens: 10 });
    await workersAiDreamLlm(chatAi(), undefined, (u) => seen.push(u)).complete({
      system: "x".repeat(40),
      user: "y".repeat(8),
      maxTokens: 10,
    });
    expect(seen[0]).toEqual({ inputTokens: 100, outputTokens: 40 });
    expect(seen[1]).toEqual({ inputTokens: 12, outputTokens: estimateTokens('{"merges": []}') });
  });
});

describe("kill switch", () => {
  it("parses flag values", () => {
    expect(parseKillSwitch(undefined)).toBe("off");
    expect(parseKillSwitch("0")).toBe("off");
    expect(parseKillSwitch("1")).toBe("workers-ai");
    expect(parseKillSwitch("true")).toBe("workers-ai");
    expect(parseKillSwitch("workers-ai")).toBe("workers-ai");
    expect(parseKillSwitch("ALL")).toBe("all");
    expect(strongerKillSwitch("workers-ai", "all")).toBe("all");
    expect(strongerKillSwitch("off", "workers-ai")).toBe("workers-ai");
  });

  it("reads the D1 flag, and the wrangler var can only strengthen it", async () => {
    const d1 = fakeD1();
    expect(await readKillSwitch(d1, {})).toBe("off");
    setKill(d1, "workers-ai");
    expect(await readKillSwitch(d1, {})).toBe("workers-ai");
    expect(await readKillSwitch(d1, { DREAMING_AI_DISABLED: "0" })).toBe("workers-ai");
    expect(await readKillSwitch(d1, { DREAMING_AI_DISABLED: "all" })).toBe("all");
    expect(await readKillSwitch(undefined, { DREAMING_AI_DISABLED: "1" })).toBe("workers-ai");
  });
});

describe("BYOK encryption", () => {
  it("round-trips and binds the ciphertext to its owner and secret", async () => {
    const sealed = await encryptSecret(SECRET, "sk-ant-api03-secret-value-1234", "u1");
    expect(sealed.ciphertext).not.toContain("secret-value");
    expect(await decryptSecret(SECRET, sealed, "u1")).toBe("sk-ant-api03-secret-value-1234");
    await expect(decryptSecret(SECRET, sealed, "u2")).rejects.toThrow();
    await expect(decryptSecret("other-secret", sealed, "u1")).rejects.toThrow();
    const again = await encryptSecret(SECRET, "sk-ant-api03-secret-value-1234", "u1");
    expect(again.iv).not.toBe(sealed.iv);
  });

  it("stores only ciphertext + a hint", async () => {
    const d1 = fakeD1();
    seedOwner(d1);
    await saveLlmKey(d1, SECRET, "u1", { provider: "anthropic", apiKey: "sk-ant-api03-abcdefghijWXYZ" });
    const row = await loadLlmKey(d1, "u1");
    expect(row).toMatchObject({ provider: "anthropic", key_hint: "sk-ant-…WXYZ", base_url: null, model: null });
    expect(JSON.stringify(row)).not.toContain("abcdefghij");
    expect(keyHint("short-key")).toBe("…-key");
  });
});

describe("chooseDreamProvider", () => {
  async function setup(opts: { spent?: number; kill?: string; byok?: "anthropic" | "openai" } = {}) {
    const d1 = fakeD1();
    seedOwner(d1);
    if (opts.spent) await recordDreamSpend(d1, "u1", utcDay(NOW), opts.spent, 1);
    if (opts.kill) setKill(d1, opts.kill);
    if (opts.byok === "anthropic") {
      await saveLlmKey(d1, SECRET, "u1", { provider: "anthropic", apiKey: "sk-ant-api03-abcdefghijWXYZ" });
    }
    if (opts.byok === "openai") {
      await saveLlmKey(d1, SECRET, "u1", {
        provider: "openai",
        apiKey: "sk-openai-abcdefghij",
        baseUrl: "https://llm.example.com/v1",
        model: "my-model",
      });
    }
    return d1;
  }
  const env = { BYOK_ENCRYPTION_KEY: SECRET };

  it("runs on metered Workers AI under the cap and records the step's spend", async () => {
    const d1 = await setup({ spent: 0.5 });
    const ai = chatAi({ prompt_tokens: 1000, completion_tokens: 1000 });
    const choice = await chooseDreamProvider({ db: d1, env, ai, ownerId: "u1", now: NOW });
    expect(choice).toMatchObject({ provider: "workers-ai", killSwitch: "off", spend: { usd: 0.5, capUsd: 1 } });
    await choice.llm!.complete({ system: "s", user: "u", maxTokens: 10 });
    await choice.llm!.complete({ system: "s", user: "u", maxTokens: 10 });
    await choice.meter!.flush();
    expect(await spentUsd(d1, "u1", utcDay(NOW))).toBeCloseTo(0.5 + 2 * (1000 * 0.293 + 1000 * 2.253) / 1e6, 6);
  });

  it("skips REM with reason budget once today's cap is spent", async () => {
    const d1 = await setup({ spent: 1 });
    const ai = chatAi();
    const choice = await chooseDreamProvider({ db: d1, env, ai, ownerId: "u1", now: NOW });
    expect(choice.llm).toBeNull();
    expect(choice.skipReason).toMatch(/^budget: /);
    // Directory policy: tool-visible text never upsells or asks for a key.
    expect(choice.skipReason).not.toMatch(/add your own|upgrade|subscri|plan\b/i);
    expect(choice.spend).toMatchObject({ usd: 1, remainingUsd: 0 });
    // A raised cap lets it run again.
    const raised = await chooseDreamProvider({
      db: d1,
      env: { ...env, DREAM_DAILY_USD_PER_ACCOUNT: "2" },
      ai,
      ownerId: "u1",
      now: NOW,
    });
    expect(raised.provider).toBe("workers-ai");
    expect(raised.llm).not.toBeNull();
  });

  it("kill switch workers-ai stops operator-paid calls but BYOK keeps running", async () => {
    const plain = await setup({ kill: "workers-ai" });
    const off = await chooseDreamProvider({ db: plain, env, ai: chatAi(), ownerId: "u1", now: NOW });
    expect(off).toMatchObject({ llm: null, killSwitch: "workers-ai" });
    expect(off.skipReason).toMatch(/^disabled: /);
    expect(off.skipReason).not.toMatch(/add your own|upgrade|subscri|plan\b/i);

    const byok = await setup({ kill: "workers-ai", byok: "anthropic" });
    const on = await chooseDreamProvider({ db: byok, env, ai: chatAi(), ownerId: "u1", now: NOW });
    expect(on.provider).toBe("byok:anthropic");
    expect(on.llm?.name).toMatch(/^byok:anthropic/);
  });

  it("kill switch all stops BYOK too; the wrangler var applies without D1", async () => {
    const d1 = await setup({ kill: "all", byok: "anthropic" });
    const choice = await chooseDreamProvider({ db: d1, env, ai: chatAi(), ownerId: "u1", now: NOW });
    expect(choice).toMatchObject({ llm: null, provider: null, killSwitch: "all" });
    expect(choice.skipReason).toMatch(/^disabled: /);
    expect(choice.skipReason).not.toMatch(/add your own|upgrade|subscri|plan\b/i);
    const viaVar = await chooseDreamProvider({
      db: await setup(),
      env: { ...env, DREAMING_AI_DISABLED: "1" },
      ai: chatAi(),
      ownerId: "u1",
      now: NOW,
    });
    expect(viaVar).toMatchObject({ llm: null, killSwitch: "workers-ai" });
  });

  it("a BYOK key is used even over the cap, and is never metered", async () => {
    const d1 = await setup({ spent: 5, byok: "openai" });
    const ai = chatAi();
    const choice = await chooseDreamProvider({ db: d1, env, ai, ownerId: "u1", now: NOW });
    expect(choice.provider).toBe("byok:openai");
    expect(choice.meter).toBeUndefined();
  });

  it("fails closed without an owner to bill", async () => {
    const choice = await chooseDreamProvider({ db: fakeD1(), env, ai: chatAi(), ownerId: null, now: NOW });
    expect(choice.llm).toBeNull();
    expect(choice.skipReason).toMatch(/^budget: /);
  });
});

describe("BYOK providers never fall back", () => {
  it("an undecryptable key yields a provider that always fails", async () => {
    const d1 = fakeD1();
    seedOwner(d1);
    await saveLlmKey(d1, SECRET, "u1", { provider: "anthropic", apiKey: "sk-ant-api03-abcdefghijWXYZ" });
    const llm = await byokDreamLlm((await loadLlmKey(d1, "u1"))!, "rotated-secret");
    await expect(llm.complete({ system: "s", user: "u", maxTokens: 10 })).rejects.toThrow(/decrypted/);
  });

  it("an invalid Anthropic key surfaces the API error", async () => {
    const d1 = fakeD1();
    seedOwner(d1);
    await saveLlmKey(d1, SECRET, "u1", { provider: "anthropic", apiKey: "sk-ant-api03-invalidinvalid" });
    const requests: { url: string; headers: Headers }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const req = url instanceof Request ? url : new Request(String(url), init);
      requests.push({ url: req.url, headers: req.headers });
      return new Response(
        JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const llm = await byokDreamLlm((await loadLlmKey(d1, "u1"))!, SECRET, fetchFn);
    await expect(llm.complete({ system: "s", user: "u", maxTokens: 10 })).rejects.toThrow();
    expect(requests[0].url).toContain("/v1/messages");
    expect(requests[0].headers.get("authorization")).toBe("Bearer sk-ant-api03-invalidinvalid");
  });

  it("an OpenAI-compatible key posts to {baseUrl}/chat/completions and fails on HTTP errors", async () => {
    const d1 = fakeD1();
    seedOwner(d1);
    await saveLlmKey(d1, SECRET, "u1", {
      provider: "openai",
      apiKey: "sk-openai-abcdefghij",
      baseUrl: "https://llm.example.com/v1/",
      model: "my-model",
    });
    let status = 200;
    const urls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-openai-abcdefghij");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"themes":[]}' } }] }), { status });
    }) as typeof fetch;
    const llm = await byokDreamLlm((await loadLlmKey(d1, "u1"))!, SECRET, fetchFn);
    expect(await llm.complete({ system: "s", user: "u", maxTokens: 10 })).toBe('{"themes":[]}');
    expect(urls[0]).toBe("https://llm.example.com/v1/chat/completions");
    status = 401;
    await expect(llm.complete({ system: "s", user: "u", maxTokens: 10 })).rejects.toThrow(/HTTP 401/);
  });
});
