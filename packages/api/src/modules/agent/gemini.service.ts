import type { FastifyBaseLogger } from "fastify";
import type { GeminiAgentOutput, IntentType } from "@voice-agent/shared-types";
import { env } from "../../env.js";
import {
  assertWithinBudget,
  TOKEN_BUDGETS,
  estimateTokens,
  BudgetExceededError,
} from "../../utils/token-budget.js";
import { mockGeminiOutput } from "../../utils/voice-mock.js";
import { recordFailure, CircuitOpenError } from "../../utils/circuit-breaker.js";
import {
  AGENT_RESPONSE_JSON_SCHEMA_STRICT,
  GEMINI_AGENT_RESPONSE_JSON_SCHEMA,
  GeminiAgentOutputSchema,
  type GeminiAgentOutputParsed,
} from "./gemini.schema.js";
import { withCurrentDate } from "./gemini.tools.js";
import { IDENTITY_PROMPT_LINE } from "./app-identity.js";
import { TIME_OF_DAY_PROMPT_RULE } from "./time-of-day.js";
import { LlmUnavailableError, generateLlm, llmChain, type LlmResult } from "./llm.call.js";
import { AgentTurnAbortedError, isTurnAborted } from "../../utils/turn-abort.js";

export const AGENT_TEMPERATURE = 0.1;

export const SYSTEM_PROMPT = `You are a voice assistant. Your reply is spoken aloud: plain text, no markdown, at most 3 sentences.
Return JSON with "reply", "intent" and "card".

Pick exactly one intent:
- "general": factual or everyday questions (facts, numbers, definitions, people, places, dates, "what day is it"). Answer in 1-2 short sentences. card: null.
- "weather", "reminder", "translate": the user asks for that task. The app runs the real tool and fills in the data. In the card put only what the user said (weather: "location"; translate: "original", "toLang", "fromLang"; reminder: "note", "time") and "" in every other field, or card: null. Never write weather values, translations or reminder confirmations yourself.
- "summarize": the user asks for a summary. Include the summary card only if you can fill every field, otherwise card: null.
- "help": only when the user explicitly asks for help or what you can do. Thanks, or words like "aid" in a question, are not help.
Synonyms, antonyms and rephrasing are "general", not "translate"; never translate a language into itself.
- "fallback": only when the request is unintelligible. Never use it for a question you can answer.

This app's features: weather (current weather for a city), reminders (saved as a note only when the user says "remind me to ..."; the app cannot notify or alert the user when a reminder is due, so never promise that it will), translation of short phrases, and summaries (of what the user says or of this conversation).
A question ABOUT a feature ("what does reminder do?", "how does translation work?") is "help": explain the feature, do not perform it, card: null.
${IDENTITY_PROMPT_LINE}

Rules for every answer, especially "general":
- Only state facts you are confident are true. If you are not sure, say "I'm not sure" (and, if useful, what you do know). A short honest answer beats a confident wrong one.
- Never invent products, models, companies, acronym expansions, laws, regulations, places, people, events or numbers.
- No scientific (Latin) names, exact figures, dates, statistics, measurements or quotes unless you are certain they are correct. Otherwise describe it in plain words, give a rough range ("a few thousand years ago"), or say "I'm not sure". Prefer "I'm not sure" over a precise-sounding guess.
- Resolve acronyms and short names from the conversation so far first: if the user or you already said what MCP means, keep that meaning.
- The user's words come from speech recognition and can be misheard. If a word looks like a transcription error or a name you do not recognise (for example "ChargeGBT"), do not guess what it is: ask "Did you mean …?" with the most likely intended word.
- You can only talk and use the features listed above. You cannot control the microphone, the speaker, other apps, websites, files or device settings, and you cannot send messages, notifications or alerts, or make purchases. Never claim you did any of these and never promise to remind or notify the user later; say you cannot.
- A fragment that is clearly an unfinished sentence should get a short request to finish the thought, not a guessed answer.
${TIME_OF_DAY_PROMPT_RULE}

Use the current date and time above for anything relative to now (today, tomorrow, this year).
card is null or exactly one of these shapes:
{"type":"weather","icon","temp","desc","humidity","wind","location"}
{"type":"reminder","note","time"}
{"type":"translate","original","translated","fromLang","toLang"}
{"type":"summary","points":[string],"source"}
{"type":"help","commands":[{"name","description"}]}`;

/** Agent output plus which provider/model produced it (for per-reply logging). */
export type AgentOutput = GeminiAgentOutput & { source?: string };

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

/** Slack the per-call estimate adds for the JSON reply framing. */
const AGENT_PROMPT_OVERHEAD_TOKENS = 120;

/** Estimated tokens of one agent call, as the per-call check counts them. */
export function agentPromptTokens(system: string, user: string): number {
  return estimateTokens(system) + estimateTokens(user) + AGENT_PROMPT_OVERHEAD_TOKENS;
}

/**
 * True when `user` (utterance plus any history) fits the per-call
 * agent_response budget with today's system prompt. buildPromptWithContext
 * trims history with it, so history alone can never cause a refusal.
 */
export function fitsAgentPromptBudget(user: string, now: Date = new Date()): boolean {
  return (
    agentPromptTokens(withCurrentDate(SYSTEM_PROMPT, now), user) <= TOKEN_BUDGETS.agent_response
  );
}

export async function generateAgentOutput(
  userText: string,
  log: FastifyBaseLogger,
  preferredIntent?: IntentType,
  signal?: AbortSignal,
): Promise<AgentOutput> {
  const system = withCurrentDate(SYSTEM_PROMPT);
  // Per-call ceiling (not the daily cap — that is B2's reservation in
  // generateLlm). History is already trimmed to fit, so this only fires when
  // the system prompt plus the utterance itself are too big.
  assertWithinBudget("agent_response", agentPromptTokens(system, userText));

  if (env.VOICE_MOCK) {
    const intent: IntentType = preferredIntent ?? "fallback";
    log.debug({ intent }, "Gemini service mock path");
    return { ...mockGeminiOutput(intent), source: "mock" };
  }

  if (llmChain().length === 0) {
    throw new Error("GEMINI_API_KEY (or GROQ_API_KEY) is required when VOICE_MOCK=false");
  }

  if (signal?.aborted) {
    throw new AgentTurnAbortedError("Gemini request aborted before start");
  }

  log.info(
    { chain: llmChain().map((c) => `${c.provider}/${c.model}`), textLen: userText.length },
    "LLM request",
  );

  // Breakers are checked and settled per provider inside generateLlm, so an
  // open Gemini circuit no longer blocks the Groq fallback.
  let result: LlmResult;
  try {
    result = await generateLlm(
      {
        system,
        user: userText,
        // Low: factual answers, not creative ones (fewer invented details).
        temperature: AGENT_TEMPERATURE,
        json: {
          name: "agent_reply",
          schema: GEMINI_AGENT_RESPONSE_JSON_SCHEMA,
          strictSchema: AGENT_RESPONSE_JSON_SCHEMA_STRICT,
        },
      },
      { signal, log },
    );
  } catch (err) {
    if (signal?.aborted) {
      throw new AgentTurnAbortedError("Gemini request aborted");
    }
    throw err;
  }
  const rawText = result.text;
  const { finishReason, usage, provider } = result;

  if (signal?.aborted) {
    throw new AgentTurnAbortedError("Gemini request aborted after response");
  }

  log.info({ provider, model: result.model, finishReason, usage }, "LLM response");

  if (!rawText) {
    // Empty body is a provider-side anomaly.
    recordFailure(provider);
    log.error({ finishReason, usage }, "Gemini returned an empty response");
    throw new GeminiParseError("Empty response from Gemini", "", finishReason);
  }

  // Parse errors below do NOT trip the breaker — they indicate a prompt /
  // schema problem, not provider unavailability.
  return { ...parseAndValidate(rawText, log, finishReason), source: `${provider}/${result.model}` };
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
): Promise<AgentOutput> {
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
      // Name the real cause: only the daily cap is a "daily limit".
      if (err.operation === "daily") {
        log.warn({ err }, "Daily token cap reached");
        return {
          reply: "I am over my daily limit. Please try again later.",
          intent: "fallback",
          card: null,
        };
      }
      log.warn({ err }, "Prompt over the per-call token budget");
      return {
        reply:
          "That message is too long for me to answer in one go. Please ask a shorter question.",
        intent: "fallback",
        card: null,
      };
    }
    if (err instanceof LlmUnavailableError) {
      log.warn({ failures: err.failures }, "Every LLM provider failed — telling the user");
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
