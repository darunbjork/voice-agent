import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { GeminiUnavailableError, generateWithFallback } from "./gemini.call.js";
import { env } from "../../env.js";
import { assertWithinBudget, estimateTokens } from "../../utils/token-budget.js";
import { assertCircuitClosed, recordSuccess, recordFailure } from "../../utils/circuit-breaker.js";

/**
 * Pinned to flash-lite-preview: `gemini-flash-latest` timed out at 45s on the
 * free tier while flash-lite-preview answers in ~1.6s. Override with GEMINI_MODEL.
 */
export const GEMINI_MODEL_ID = env.GEMINI_MODEL;

/**
 * Lowest thinking level. Replies here are one to three spoken sentences; on
 * flash-lite-preview LOW spent ~120 thought tokens on "how many states does
 * the USA have", MINIMAL spends none.
 */
export const GEMINI_THINKING_CONFIG = { thinkingLevel: ThinkingLevel.MINIMAL };

export const ASSISTANT_TIME_ZONE = "Europe/Stockholm";

/**
 * "Current date and time: Friday, 20 November 2026, 15:42 (Europe/Stockholm)".
 * The model has no clock; without this it answered "today" with its training date.
 */
export function currentDateTimeLine(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ASSISTANT_TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return (
    `Current date and time: ${get("weekday")}, ${get("day")} ${get("month")} ${get("year")}, ` +
    `${get("hour")}:${get("minute")} (${ASSISTANT_TIME_ZONE})`
  );
}

/** Prefix a system prompt with the current date line. Used for every Gemini request. */
export function withCurrentDate(system: string, now: Date = new Date()): string {
  return `${currentDateTimeLine(now)}\n\n${system}`;
}

/** Tools have a deterministic fallback, so give up on Gemini sooner. */
const TOOL_ATTEMPT_TIMEOUT_MS = 6_000;
const TOOL_HEDGE_AFTER_MS = 2_500;

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
    const { response } = await generateWithFallback(
      ai,
      {
        contents: prompt,
        config: {
          systemInstruction: withCurrentDate(system),
          temperature: 0.2,
          thinkingConfig: GEMINI_THINKING_CONFIG,
        },
      },
      { attemptTimeoutMs: TOOL_ATTEMPT_TIMEOUT_MS, hedgeAfterMs: TOOL_HEDGE_AFTER_MS },
    );
    rawText = (response.text ?? "").trim();
  } catch (err) {
    if (!(err instanceof GeminiUnavailableError && err.quotaOnly)) recordFailure("gemini");
    throw err instanceof Error ? err : new ToolTextError("Gemini request failed");
  }

  if (!rawText) {
    recordFailure("gemini");
    throw new ToolTextError("Gemini returned an empty response");
  }

  recordSuccess("gemini");
  return rawText;
}
