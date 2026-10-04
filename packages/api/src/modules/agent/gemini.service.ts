import { GoogleGenAI } from "@google/genai";
import type { FastifyBaseLogger } from "fastify";
import type { GeminiAgentOutput, IntentType } from "@voice-agent/shared-types";
import { env } from "../../env.js";
import {
  assertWithinBudget,
  estimateTokens,
  BudgetExceededError,
} from "../../utils/token-budget.js";
import { mockGeminiOutput } from "../../utils/voice-mock.js";
import {
  assertCircuitClosed,
  recordSuccess,
  recordFailure,
  CircuitOpenError,
} from "../../utils/circuit-breaker.js";
import { GeminiAgentOutputSchema, type GeminiAgentOutputParsed } from "./gemini.schema.js";
import { GEMINI_MODEL_ID } from "./gemini.tools.js";
import { AgentTurnAbortedError, isTurnAborted } from "../../utils/turn-abort.js";

const MODEL_ID = GEMINI_MODEL_ID;

const SYSTEM_PROMPT = `You are a voice assistant. You respond in JSON only.
Classify the user's intent and return the correct card structure.
Responses must be concise — they will be spoken aloud.
Maximum reply length: 3 sentences.
No markdown in reply text.

Respond ONLY with this JSON:
{
  "reply": "spoken response text — no markdown, max 3 sentences",
  "intent": "weather" | "reminder" | "translate" | "summarize" | "help" | "fallback",
  "card": { ... matching card type ... } | null
}`;

export class GeminiParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = "GeminiParseError";
  }
}

export async function generateAgentOutput(
  userText: string,
  log: FastifyBaseLogger,
  preferredIntent?: IntentType,
  signal?: AbortSignal,
): Promise<GeminiAgentOutput> {
  const estimated = estimateTokens(userText) + estimateTokens(SYSTEM_PROMPT) + 120;
  assertWithinBudget("agent_response", estimated);

  if (env.VOICE_MOCK) {
    const intent: IntentType = preferredIntent ?? "fallback";
    log.debug({ intent }, "Gemini service mock path");
    return mockGeminiOutput(intent);
  }

  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required when VOICE_MOCK=false");
  }

  if (signal?.aborted) {
    throw new AgentTurnAbortedError("Gemini request aborted before start");
  }

  assertCircuitClosed("gemini");

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  log.info({ model: MODEL_ID, textLen: userText.length }, "Gemini request");

  let rawText: string;
  try {
    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: userText,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.3,
        responseMimeType: "application/json",
        abortSignal: signal,
      },
    });
    rawText = response.text ?? "";
  } catch (err) {
    if (signal?.aborted) {
      throw new AgentTurnAbortedError("Gemini request aborted");
    }
    // Network / API failure — counts toward the breaker.
    recordFailure("gemini");
    throw err;
  }

  if (signal?.aborted) {
    throw new AgentTurnAbortedError("Gemini request aborted after response");
  }

  if (!rawText) {
    // Empty body is a provider-side anomaly.
    recordFailure("gemini");
    throw new GeminiParseError("Empty response from Gemini", "");
  }

  // Parse errors below do NOT trip the breaker — they indicate a prompt /
  // schema problem, not provider unavailability.
  const parsed = parseAndValidate(rawText, log);
  recordSuccess("gemini");
  return parsed;
}

function parseAndValidate(raw: string, log: FastifyBaseLogger): GeminiAgentOutputParsed {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      log.error({ raw }, "Gemini returned non-JSON");
      throw new GeminiParseError("Gemini returned non-JSON", raw);
    }
    try {
      json = JSON.parse(match[0]);
    } catch {
      throw new GeminiParseError("Gemini returned unparseable JSON", raw);
    }
  }

  const parsed = GeminiAgentOutputSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.flatten(), raw }, "Gemini JSON failed Zod validation");
    throw new GeminiParseError(`Zod validation failed: ${parsed.error.message}`, raw);
  }

  return parsed.data;
}

export async function safeGenerateAgentOutput(
  userText: string,
  log: FastifyBaseLogger,
  preferredIntent?: IntentType,
  signal?: AbortSignal,
): Promise<GeminiAgentOutput> {
  try {
    return await generateAgentOutput(userText, log, preferredIntent, signal);
  } catch (err) {
    if (isTurnAborted(err, signal)) throw err;
    if (err instanceof CircuitOpenError) {
      log.warn({ provider: err.provider }, "Circuit open — skipping Gemini");
      return {
        reply: "I am temporarily unable to think that through. Please try again shortly.",
        intent: "fallback",
        card: null,
      };
    }
    if (err instanceof BudgetExceededError) {
      log.warn({ err }, "Gemini budget exceeded");
      return {
        reply: "I am over my daily limit. Please try again later.",
        intent: "fallback",
        card: null,
      };
    }
    if (err instanceof GeminiParseError) {
      log.warn({ err }, "Gemini parse failure — using fallback");
      return {
        reply: "Sorry, I had trouble understanding that. Could you rephrase?",
        intent: "fallback",
        card: null,
      };
    }
    log.error({ err }, "Gemini unexpected error");
    return {
      reply: "Something went wrong on my side. Please try again.",
      intent: "fallback",
      card: null,
    };
  }
}
