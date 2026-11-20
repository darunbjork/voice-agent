import { env } from "../../env.js";
import type { LlmText } from "./llm.call.js";

/** OpenAI-compatible Groq endpoint. */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** Spoken replies are short; this also caps a runaway generation. */
const GROQ_MAX_COMPLETION_TOKENS = 512;

export class GroqApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Groq ${status}: ${body.slice(0, 300)}`);
    this.name = "GroqApiError";
  }
}

export type GroqChatInput = {
  model: string;
  system: string;
  user: string;
  temperature: number;
  /** Strict JSON Schema (every object closed with additionalProperties: false). */
  json?: { name: string; schema: object };
  signal: AbortSignal;
};

type ChatCompletion = {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: unknown;
};

/**
 * One chat completion. gpt-oss models reason before answering: effort "low"
 * spent 4–11 reasoning tokens and answered in 0.3–0.5 s in a live probe
 * ("medium" spent up to 253). Reasoning text is not returned.
 */
export async function groqChat(input: GroqChatInput): Promise<LlmText> {
  const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      temperature: input.temperature,
      max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS,
      ...(input.model.startsWith("openai/gpt-oss")
        ? { reasoning_effort: "low", include_reasoning: false }
        : {}),
      ...(input.json
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: input.json.name, strict: true, schema: input.json.schema },
            },
          }
        : {}),
    }),
    signal: input.signal,
  });

  if (!res.ok) {
    throw new GroqApiError(res.status, await res.text().catch(() => res.statusText));
  }

  const data = (await res.json()) as ChatCompletion;
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason,
    usage: data.usage,
  };
}
