import { GoogleGenAI } from "@google/genai";
import { env } from "../../env.js";
import { assertWithinBudget, estimateTokens } from "../../utils/token-budget.js";
import { assertCircuitClosed, recordSuccess, recordFailure } from "../../utils/circuit-breaker.js";

export const GEMINI_MODEL_ID = "gemini-flash-latest";

const REQUEST_TIMEOUT_MS = 8_000;

export class ToolTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolTextError";
  }
}

/**
 * Plain-text Gemini call used by tool backends (translate, summarize).
 * Throws on any failure — callers are expected to fall back to their
 * deterministic behavior (demo dictionary / sentence splitter).
 * Never throws CircuitOpenError/BudgetExceededError as ToolTextError;
 * those propagate as-is for callers that care.
 */
export async function generateToolText(system: string, prompt: string): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new ToolTextError("GEMINI_API_KEY is not configured");
  }

  assertCircuitClosed("gemini");

  const estimated = estimateTokens(prompt) + estimateTokens(system) + 200;
  assertWithinBudget("agent_response", estimated);

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  let rawText: string;
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL_ID,
      contents: prompt,
      config: {
        systemInstruction: system,
        temperature: 0.2,
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    });
    rawText = (response.text ?? "").trim();
  } catch (err) {
    recordFailure("gemini");
    throw err instanceof Error ? err : new ToolTextError("Gemini request failed");
  }

  if (!rawText) {
    recordFailure("gemini");
    throw new ToolTextError("Gemini returned an empty response");
  }

  recordSuccess("gemini");
  return rawText;
}
