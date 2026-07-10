export type EmbeddingProviderName = "local" | "openai" | "none";

export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  model?: string;
}

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

const LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";
const OPENAI_MODEL = "text-embedding-3-small";

/**
 * Create an embedder for the configured provider, or null when embeddings are
 * unavailable (provider "none", missing optional dependency, missing API key, …).
 * Never throws — unavailability must degrade gracefully to keyword-only search.
 */
export async function createEmbedder(config: EmbeddingConfig): Promise<Embedder | null> {
  try {
    switch (config.provider) {
      case "none":
        return null;
      case "openai":
        return createOpenAiEmbedder(config.model ?? OPENAI_MODEL);
      case "local":
        return await createLocalEmbedder(config.model ?? LOCAL_MODEL);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function createOpenAiEmbedder(model: string): Embedder | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI embeddings request failed: ${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => Float32Array.from(d.embedding));
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

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
