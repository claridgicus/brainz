/**
 * Dreaming's LLM providers on Brainz Cloud. Default: Workers AI through the
 * `AI` binding, paid by the operator and metered against the per-account
 * daily cap (see dream-budget.ts). A user's own key (BYOK) swaps in an
 * Anthropic or OpenAI-compatible provider — the engine only sees `DreamLlm`.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DreamLlm } from "@brainz/engine";

export const DREAM_LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Published Workers AI price for DREAM_LLM_MODEL, USD per million tokens
 * (developers.cloudflare.com/workers-ai/platform/pricing). Used to meter the
 * operator-paid spend; update together with DREAM_LLM_MODEL.
 */
export const DREAM_LLM_PRICE_USD_PER_M = { input: 0.293, output: 2.253 } as const;

/** Default model for a BYOK Anthropic key when the user names none. */
export const BYOK_ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/** Token usage of one completion (from the provider, or estimated). */
export interface DreamLlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/** chars/4 — the fallback when a provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Minimal Workers AI surface (same shape the VaultDO uses for embeddings). */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/**
 * Workers AI chat completion as a DreamLlm. Throws on empty output (REM
 * records llm-error). `onUsage` sees every successful call's token usage —
 * the binding's `usage` when present, else a chars/4 estimate.
 */
export function workersAiDreamLlm(
  ai: AiRunner,
  model = DREAM_LLM_MODEL,
  onUsage?: (usage: DreamLlmUsage) => void,
): DreamLlm {
  return {
    name: `workers-ai:${model}`,
    async complete({ system, user, maxTokens }) {
      const result = (await ai.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
      })) as {
        response?: unknown;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      } | null;
      const response = result?.response;
      let text: string | null = null;
      if (typeof response === "string" && response.trim()) text = response;
      // JSON-mode responses may arrive already parsed.
      else if (response && typeof response === "object") text = JSON.stringify(response);
      if (text === null) throw new Error("Workers AI returned no completion");
      const usage = result?.usage;
      onUsage?.({
        inputTokens:
          typeof usage?.prompt_tokens === "number"
            ? usage.prompt_tokens
            : estimateTokens(system) + estimateTokens(user),
        outputTokens:
          typeof usage?.completion_tokens === "number" ? usage.completion_tokens : estimateTokens(text),
      });
      return text;
    },
  };
}

/** Anthropic Messages API on the user's own key. Errors propagate (REM llm-error). */
export function anthropicDreamLlm(
  apiKey: string,
  model = BYOK_ANTHROPIC_DEFAULT_MODEL,
  fetchFn?: typeof fetch,
): DreamLlm {
  const client = new Anthropic({ apiKey, maxRetries: 1, ...(fetchFn ? { fetch: fetchFn } : {}) });
  return {
    name: `byok:anthropic:${model}`,
    async complete({ system, user, maxTokens }) {
      const response = await client.messages.create({
        model,
        // Thinking is on for current models and shares max_tokens with the
        // answer; give it room beyond the engine's answer budget.
        max_tokens: Math.max(maxTokens, 8000),
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: user }],
      });
      if (response.stop_reason === "refusal") throw new Error("Anthropic declined the request");
      const text = response.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      if (!text) throw new Error("Anthropic returned no completion");
      return text;
    },
  };
}

/** Any OpenAI-compatible `POST {baseUrl}/chat/completions` on the user's own key. */
export function openAiCompatibleDreamLlm(
  args: { apiKey: string; baseUrl: string; model: string },
  fetchFn: typeof fetch = fetch,
): DreamLlm {
  const url = `${args.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    name: `byok:openai:${args.model}`,
    async complete({ system, user, maxTokens }) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
        body: JSON.stringify({
          model: args.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.1,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new Error("OpenAI-compatible endpoint returned no completion");
      return text;
    },
  };
}

/** A provider that always fails — a BYOK key that can't be used must never fall back. */
export function failingDreamLlm(name: string, message: string): DreamLlm {
  return {
    name,
    async complete() {
      throw new Error(message);
    },
  };
}
