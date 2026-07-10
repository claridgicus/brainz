/**
 * createEmbedder unit tests (provider selection + the Cloudflare embedder's
 * HTTP contract, with fetch mocked). Vault-level degradation is covered in
 * vault.test.ts; these pin the provider factory itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUDFLARE_BATCH_SIZE, createEmbedder } from "../src/embeddings.js";

beforeEach(() => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubCreds() {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-123");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok-456");
}

function cfResponse(vectors: number[][]) {
  return new Response(JSON.stringify({ success: true, result: { shape: [vectors.length, 2], data: vectors } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createEmbedder provider selection", () => {
  it('"none" → null (keyword-only)', async () => {
    expect(await createEmbedder({ provider: "none" })).toBeNull();
  });

  it("unknown provider → null, never a throw", async () => {
    expect(await createEmbedder({ provider: "openai" as never })).toBeNull();
  });

  it("cloudflare without credentials → null and no network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await createEmbedder({ provider: "cloudflare" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('"local" → null when @xenova/transformers is not installed', async () => {
    // The optional dependency is not part of this repo's dev install.
    expect(await createEmbedder({ provider: "local" })).toBeNull();
  });
});

describe("cloudflare embedder HTTP contract", () => {
  it("POSTs the batch to the account/model URL with the bearer token and returns Float32Arrays", async () => {
    stubCreds();
    const fetchSpy = vi.fn(async () => cfResponse([[0.1, 0.2], [0.3, 0.4]]));
    vi.stubGlobal("fetch", fetchSpy);

    const embedder = await createEmbedder({ provider: "cloudflare" });
    expect(embedder).not.toBeNull();
    const out = await embedder!.embed(["alpha", "beta"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/baai/bge-base-en-v1.5",
    );
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-456");
    expect(JSON.parse(init.body as string)).toEqual({ text: ["alpha", "beta"] });

    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(out[0]).map((v) => Math.round(v * 10) / 10)).toEqual([0.1, 0.2]);
  });

  it("honors a custom model name in the URL", async () => {
    stubCreds();
    const fetchSpy = vi.fn(async () => cfResponse([[1, 2]]));
    vi.stubGlobal("fetch", fetchSpy);
    const embedder = await createEmbedder({ provider: "cloudflare", model: "@cf/custom/model" });
    await embedder!.embed(["x"]);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/ai/run/@cf/custom/model");
  });

  it(`chunks input into batches of ${CLOUDFLARE_BATCH_SIZE}, preserving order across requests`, async () => {
    stubCreds();
    const texts = Array.from({ length: CLOUDFLARE_BATCH_SIZE + 3 }, (_, i) => `t${i}`);
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const { text } = JSON.parse(init.body as string) as { text: string[] };
      return cfResponse(text.map((t) => [Number(t.slice(1)), 0]));
    });
    vi.stubGlobal("fetch", fetchSpy);

    const embedder = await createEmbedder({ provider: "cloudflare" });
    const out = await embedder!.embed(texts);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBatch = JSON.parse(fetchSpy.mock.calls[0][1].body as string).text;
    const secondBatch = JSON.parse(fetchSpy.mock.calls[1][1].body as string).text;
    expect(firstBatch).toHaveLength(CLOUDFLARE_BATCH_SIZE);
    expect(secondBatch).toHaveLength(3);
    expect(out).toHaveLength(texts.length);
    // Order preserved end-to-end: vector i encodes index i.
    expect(out[0][0]).toBe(0);
    expect(out[CLOUDFLARE_BATCH_SIZE][0]).toBe(CLOUDFLARE_BATCH_SIZE);
    expect(out[texts.length - 1][0]).toBe(texts.length - 1);
  });

  it("non-2xx response → embed() throws (callers degrade to keyword-only)", async () => {
    stubCreds();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" })));
    const embedder = await createEmbedder({ provider: "cloudflare" });
    await expect(embedder!.embed(["x"])).rejects.toThrow(/503/);
  });

  it("success: false → embed() throws on the unexpected payload", async () => {
    stubCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "denied" }] }), { status: 200 })),
    );
    const embedder = await createEmbedder({ provider: "cloudflare" });
    await expect(embedder!.embed(["x"])).rejects.toThrow(/unexpected/);
  });

  it("vector-count mismatch with the request chunk → embed() throws", async () => {
    stubCreds();
    vi.stubGlobal("fetch", vi.fn(async () => cfResponse([[1, 2]])));
    const embedder = await createEmbedder({ provider: "cloudflare" });
    await expect(embedder!.embed(["a", "b"])).rejects.toThrow(/unexpected/);
  });
});
