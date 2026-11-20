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
import {
  GEMINI_AGENT_RESPONSE_JSON_SCHEMA,
  GeminiAgentOutputSchema,
  type GeminiAgentOutputParsed,
} from "./gemini.schema.js";
import { GEMINI_THINKING_CONFIG, withCurrentDate } from "./gemini.tools.js";
import { GeminiUnavailableError, generateWithFallback, geminiModels } from "./gemini.call.js";
import { AgentTurnAbortedError, isTurnAborted } from "../../utils/turn-abort.js";

export const SYSTEM_PROMPT = `You are a voice assistant. Your reply is spoken aloud: plain text, no markdown, at most 3 sentences.
Return JSON with "reply", "intent" and "card".

Pick exactly one intent:
- "general": factual or everyday questions (facts, numbers, definitions, people, places, dates, "what day is it"). Answer directly and correctly in 1-2 short sentences. card: null.
- "weather", "reminder", "translate", "summarize": the user asks for that task. Include the matching card only if you can fill every field, otherwise card: null.
- "help": only when the user asks what you can do.
- "fallback": only when the request is unintelligible. Never use it for a question you can answer.

This app's features: weather (current weather for a city), reminders (saved only when the user says "remind me to ..."), translation of short phrases, and summaries (of what the user says or of this conversation).
A question ABOUT a feature ("what does reminder do?", "how does translation work?") is "help": explain the feature, do not perform it, card: null.

Use the current date and time above for anything relative to now (today, tomorrow, this year).
card is null or exactly one of these shapes:
{"type":"weather","icon","temp","desc","humidity","wind","location"}
{"type":"reminder","note","time"}
{"type":"translate","original","translated","fromLang","toLang"}
{"type":"summary","points":[string],"source"}
{"type":"help","commands":[{"name","description"}]}`;

export class GeminiParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly finishReason?: string,
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

  log.info({ models: geminiModels(), textLen: userText.length }, "Gemini request");

  let rawText: string;
  let finishReason: string | undefined;
  let usage: unknown;
  let answeredBy: string | undefined;
  try {
    const { response, model } = await generateWithFallback(
      ai,
      {
        contents: userText,
        config: {
          systemInstruction: withCurrentDate(SYSTEM_PROMPT),
          temperature: 0.3,
          responseMimeType: "application/json",
          responseJsonSchema: GEMINI_AGENT_RESPONSE_JSON_SCHEMA,
          thinkingConfig: GEMINI_THINKING_CONFIG,
        },
      },
      { signal, log },
    );
    answeredBy = model;
    rawText = response.text ?? "";
    finishReason = response.candidates?.[0]?.finishReason;
    usage = response.usageMetadata;
  } catch (err) {
    if (signal?.aborted) {
      throw new AgentTurnAbortedError("Gemini request aborted");
    }
    // Every attempt failed. Rate limits (429) are budget, not a provider fault.
    if (!(err instanceof GeminiUnavailableError && err.quotaOnly)) recordFailure("gemini");
    throw err;
  }

  if (signal?.aborted) {
    throw new AgentTurnAbortedError("Gemini request aborted after response");
  }

  log.info({ model: answeredBy, finishReason, usage }, "Gemini response");

  if (!rawText) {
    // Empty body is a provider-side anomaly.
    recordFailure("gemini");
    log.error({ finishReason, usage }, "Gemini returned an empty response");
    throw new GeminiParseError("Empty response from Gemini", "", finishReason);
  }

  // Parse errors below do NOT trip the breaker — they indicate a prompt /
  // schema problem, not provider unavailability.
  const parsed = parseAndValidate(rawText, log, finishReason);
  recordSuccess("gemini");
  return parsed;
}

export function parseAndValidate(
  raw: string,
  log: FastifyBaseLogger,
  finishReason?: string,
): GeminiAgentOutputParsed {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      log.error({ raw, finishReason }, "Gemini returned non-JSON");
      throw new GeminiParseError("Gemini returned non-JSON", raw, finishReason);
    }
    try {
      json = JSON.parse(match[0]);
    } catch {
      log.error({ raw, finishReason }, "Gemini returned unparseable JSON");
      throw new GeminiParseError("Gemini returned unparseable JSON", raw, finishReason);
    }
  }

  const parsed = GeminiAgentOutputSchema.safeParse(json);
  if (parsed.success) return parsed.data;

  // A usable spoken reply with a malformed card: keep the answer, drop the card.
  if (json !== null && typeof json === "object" && "card" in json) {
    const withoutCard = GeminiAgentOutputSchema.safeParse({ ...json, card: null });
    if (withoutCard.success) {
      log.warn(
        { issues: parsed.error.flatten(), raw, finishReason },
        "Gemini card failed validation — dropping card, keeping reply",
      );
      return withoutCard.data;
    }
  }

  log.error(
    { issues: parsed.error.flatten(), raw, finishReason },
    "Gemini JSON failed Zod validation",
  );
  throw new GeminiParseError(`Zod validation failed: ${parsed.error.message}`, raw, finishReason);
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
    if (err instanceof GeminiUnavailableError) {
      log.warn({ failures: err.failures }, "Gemini unavailable — telling the user");
      return {
        reply: "I could not reach my language model just now. Please ask again in a moment.",
        intent: "fallback",
        card: null,
      };
    }
    if (err instanceof GeminiParseError) {
      log.warn({ err, finishReason: err.finishReason }, "Gemini parse failure — using fallback");
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
