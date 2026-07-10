export type EmbeddingProviderName = "cloudflare" | "local" | "none";

export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  model?: string;
}

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

const CLOUDFLARE_MODEL = "@cf/baai/bge-base-en-v1.5";
const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Env vars required by the "cloudflare" provider (Workers AI REST API). */
export const CLOUDFLARE_ENV_VARS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;

/** Max texts sent per Workers AI request. The API accepts an array of texts;
 * the docs publish no hard item limit, so chunk conservatively. */
export const CLOUDFLARE_BATCH_SIZE = 100;

/**
 * Create an embedder for the configured provider, or null when embeddings are
 * unavailable (provider "none", missing optional dependency, missing credentials, …).
 * Never throws — unavailability must degrade gracefully to keyword-only search.
 */
export async function createEmbedder(config: EmbeddingConfig): Promise<Embedder | null> {
  try {
    switch (config.provider) {
      case "none":
        return null;
      case "cloudflare":
        return createCloudflareEmbedder(config.model ?? CLOUDFLARE_MODEL);
      case "local":
        return await createLocalEmbedder(config.model ?? LOCAL_MODEL);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Cloudflare Workers AI embeddings (default: @cf/baai/bge-base-en-v1.5, 768-dim).
 * POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}
 * with `{ "text": string[] }`; the response is
 * `{ result: { shape: number[], data: number[][] }, success: boolean }`.
 * Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; missing creds → null.
 */
function createCloudflareEmbedder(model: string): Embedder | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += CLOUDFLARE_BATCH_SIZE) {
        const chunk = texts.slice(i, i + CLOUDFLARE_BATCH_SIZE);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({ text: chunk }),
        });
        if (!res.ok) {
          throw new Error(
            `Cloudflare Workers AI embeddings request failed: ${res.status} ${res.statusText}`,
          );
        }
        const json = (await res.json()) as {
          success?: boolean;
          result?: { shape?: number[]; data?: number[][] };
        };
        const data = json.result?.data;
        if (json.success === false || !Array.isArray(data) || data.length !== chunk.length) {
          throw new Error("Cloudflare Workers AI returned an unexpected embeddings response");
        }
        for (const vector of data) out.push(Float32Array.from(vector));
      }
      return out;
    },
  };
}

/**
 * Local embeddings via @xenova/transformers, imported dynamically so the
 * package is truly optional. If it is not installed (or fails to load, e.g.
 * offline model download), returns null and the vault falls back to keyword search.
 */
async function createLocalEmbedder(model: string): Promise<Embedder | null> {
  const moduleName = "@xenova/transformers";
  let pipe: (text: string, opts: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;
  try {
    // Non-literal specifier keeps TypeScript from requiring the package to be installed.
    const mod = (await import(moduleName)) as {
      pipeline: (task: string, model: string) => Promise<typeof pipe>;
    };
    pipe = await mod.pipeline("feature-extraction", model);
  } catch {
    return null;
  }
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (const text of texts) {
        const res = await pipe(text, { pooling: "mean", normalize: true });
        out.push(Float32Array.from(res.data));
      }
      return out;
    },
  };
}
