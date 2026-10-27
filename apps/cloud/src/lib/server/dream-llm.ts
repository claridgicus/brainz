/**
 * Dreaming's LLM provider seam on Brainz Cloud. Default: Workers AI through the
 * `AI` binding (no key to manage). An Anthropic-backed DreamLlm can replace it
 * later without touching the engine — the engine only sees `DreamLlm`.
 */
import type { DreamLlm } from "@brainz/engine";

export const DREAM_LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Minimal Workers AI surface (same shape the VaultDO uses for embeddings). */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Workers AI chat completion as a DreamLlm. Throws on empty output (REM records llm-error). */
export function workersAiDreamLlm(ai: AiRunner, model = DREAM_LLM_MODEL): DreamLlm {
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
      })) as { response?: unknown } | null;
      const response = result?.response;
      if (typeof response === "string" && response.trim()) return response;
      // JSON-mode responses may arrive already parsed.
      if (response && typeof response === "object") return JSON.stringify(response);
      throw new Error("Workers AI returned no completion");
    },
  };
}
