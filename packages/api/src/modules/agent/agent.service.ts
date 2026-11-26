import type { FastifyBaseLogger } from "fastify";
import type {
  AgentReply,
  GeminiAgentOutput,
  IntentType,
  LatencyBreakdown,
} from "@voice-agent/shared-types";
import {
  classifyByKeywords,
  isExplicitHelpRequest,
  isFeatureQuestion,
  type ClassifyResult,
} from "./intent.classifier.js";
import { resolveLanguage } from "./translate-request.js";
import {
  cleanPhrase,
  normaliseTranscript,
  parseLanguageAnswer,
  parseMeaningWithoutLanguage,
} from "./translate-request.js";
import {
  setPendingTranslation,
  setPendingWeather,
  takePendingTranslation,
  takePendingWeather,
  type PendingTranslation,
} from "./pending-requests.js";
import { fitsAgentPromptBudget, safeGenerateAgentOutput } from "./gemini.service.js";
import { runTool, type ToolResult } from "./tool.registry.js";
import { cleanLocation, extractWeatherLocation } from "./location.js";
import { identityAnswer } from "./app-identity.js";
import { dateAnswer } from "./date-answers.js";
import { fitGreetingsToTime } from "./time-of-day.js";
import type { SessionContextTurn } from "../session/session.service.js";
import { assertNotAborted } from "../../utils/turn-abort.js";

export type HandleUtteranceInput = {
  text: string;
  sessionId: string;
  turnIndex: number;
  sttLatencyMs: number;
  context?: SessionContextTurn[];
  /** Full session history, loaded only when needed ("summarize everything we discussed"). */
  loadHistory?: () => Promise<SessionContextTurn[]>;
  signal?: AbortSignal;
};

export type HandleUtteranceResult = {
  reply: AgentReply;
  viaFastPath: boolean;
  pipelineMs: number;
};

export const MAX_INPUT_CHARS = 500;
/** Recent conversation sent with a general question (~750 tokens). */
export const MAX_CONTEXT_CHARS = 3000;

/**
 * The current utterance with the recent conversation, newest turns kept, so
 * acronyms resolve from what was said ("MCP" = Model Context Protocol, not a
 * guessed expansion). Oldest lines are dropped until the prompt fits both
 * MAX_CONTEXT_CHARS and the per-call token budget (system prompt included):
 * a long session must never be refused because of its history (live: after
 * ~20 turns every reply was "I am over my daily limit").
 */
export function buildPromptWithContext(text: string, context: SessionContextTurn[]): string {
  const lines = context
    .filter((t) => t.text.trim().length > 0)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text.trim()}`);
  const withHistory = (): string =>
    `Conversation so far:\n${lines.join("\n")}\n\nCurrent message from the user:\n${text}`;
  while (
    lines.length > 0 &&
    (lines.join("\n").length > MAX_CONTEXT_CHARS || !fitsAgentPromptBudget(withHistory()))
  ) {
    lines.shift();
  }
  return lines.length === 0 ? text : withHistory();
}
/** Most recent part of the conversation that is sent for a summary (~1k tokens). */
export const MAX_CONVERSATION_SUMMARY_CHARS = 4000;

/**
 * "User: …\nAgent: …" transcript of the session, newest kept when it is too
 * long. Returns "" when nothing has been discussed yet.
 */
export function formatConversation(turns: SessionContextTurn[]): string {
  const lines = turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) => `${t.role === "user" ? "User" : "Agent"}: ${t.text.trim()}`);
  let text = lines.join("\n");
  while (text.length > MAX_CONVERSATION_SUMMARY_CHARS && lines.length > 1) {
    lines.shift();
    text = lines.join("\n");
  }
  return text.slice(-MAX_CONVERSATION_SUMMARY_CHARS);
}

async function loadConversation(
  input: HandleUtteranceInput,
  log: FastifyBaseLogger,
): Promise<string> {
  let turns = input.context ?? [];
  if (input.loadHistory) {
    try {
      turns = await input.loadHistory();
    } catch (err) {
      log.warn({ err }, "Could not load session history — using recent context");
    }
  }
  return formatConversation(turns);
}

const translateTurn = (slots: Record<string, string>): ClassifyResult => ({
  intent: "translate",
  viaFastPath: true,
  confidence: 1,
  slots,
});

const WANTS_MEANING =
  /^(?:the\s+)?(?:meaning|definition)\b|\bdefine\b|\bwhat\s+it\s+means\b|^explain\b/i;

/**
 * The previous turn asked for a missing piece of a translation. Returns the
 * completed translation, a rewritten "what does X mean?" if the user wanted
 * the meaning instead, or null when the new utterance is something else.
 */
/** The whole answer says "stop": "nothing", "cancel", "never mind", "no thanks". */
const CANCEL_PENDING =
  /^(?:no|nope|nothing|none|cancel|stop|never\s*mind|forget\s+(?:it|about\s+it)|skip(?:\s+it)?)(?:[\s,.!]+(?:thanks?|thank\s+you|please))?[\s,.!]*$/i;

/** "no, …" / "actually, …" / "I meant …" in front of a corrected answer. */
const CORRECTION_LEAD =
  /^(?:(?:(?:no|nope|sorry|actually|wait|oops|oh)[\s,.!]+)+(?:i\s+meant?\s+|make\s+it\s+|it\s+should\s+be\s+|rather\s+)?|i\s+meant?\s+)/i;

export const TRANSLATE_CANCELLED_REPLY = "Okay, no translation. What else can I help with?";

export function completePendingTranslation(
  pending: PendingTranslation,
  text: string,
  fast: ClassifyResult | null,
):
  | { kind: "translate"; slots: Record<string, string> }
  | { kind: "meaning"; text: string }
  | { kind: "cancel" }
  | null {
  const answer = text.trim();
  // Never translate "nothing" / "cancel": they end the pending request.
  if (CANCEL_PENDING.test(answer)) return { kind: "cancel" };
  const corrected = answer.replace(CORRECTION_LEAD, "").trim();
  const isCorrection = corrected.length > 0 && corrected !== answer;
  const reply = isCorrection ? corrected : answer;

  if (pending.original && !pending.toLang) {
    if (WANTS_MEANING.test(reply)) {
      return { kind: "meaning", text: `What does "${pending.original}" mean?` };
    }
    const language = parseLanguageAnswer(reply);
    return language ? { kind: "translate", slots: { ...pending, toLang: language.name } } : null;
  }
  if (!pending.original && pending.toLang) {
    if (fast && fast.intent !== "translate") return null;
    // "No, I meant Spanish": a new language, and the phrase is asked again.
    const language = isCorrection ? parseLanguageAnswer(reply) : null;
    if (language) return { kind: "translate", slots: { ...pending, toLang: language.name } };
    const original = cleanPhrase(normaliseTranscript(reply));
    return original ? { kind: "translate", slots: { ...pending, original } } : null;
  }
  return null;
}

/**
 * "What does good night mean?" (no language) is treated as a translation
 * request — the tool then asks which language — when the phrase has several
 * words or the conversation was just about translations. A single word
 * ("What does endemic mean?") stays a definition question.
 */
function meaningLooksLikeTranslation(phrase: string, context: SessionContextTurn[]): boolean {
  if (phrase.trim().split(/\s+/).length >= 2) return true;
  return context.slice(-4).some((t) => t.role === "agent" && t.intent === "translate");
}

/** Starts that make an utterance a question or command, not a place name. */
const NOT_A_PLACE =
  /^(?:what|how|why|who|when|where|which|can|could|would|will|should|is|are|do|does|did|tell|explain|give|show|summari[sz]e|translate|remind)\b/i;
const CANCEL = /^(?:no|nope|nothing|cancel|stop|never\s*mind|forget\s+it|skip(?:\s+it)?)\b/i;

/**
 * A short answer to "Which city?" ("Paris", "in New York please"), or null
 * when the utterance is something else (a question, a cancel, a long sentence).
 */
export function placeAnswer(text: string): string | null {
  const t = text.trim();
  if (!t || NOT_A_PLACE.test(t) || CANCEL.test(t)) return null;
  const place = cleanLocation(t);
  if (!place || place.split(/\s+/).length > 4) return null;
  return place;
}

/** Tools whose data (numbers, translations, saved state) the model must never write. */
const TOOL_DATA_INTENTS: ReadonlySet<IntentType> = new Set(["weather", "translate", "reminder"]);

const nonEmpty = (slots: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(slots).filter(([, v]) => v.trim().length > 0));

/** Turns a tool result into the reply and remembers any question it asked. */
function applyToolResult(
  intent: IntentType,
  result: ToolResult,
  sessionId: string,
  request: string,
): GeminiAgentOutput {
  if (result.pending && Object.keys(result.pending).length > 0) {
    setPendingTranslation(sessionId, result.pending);
  }
  if (intent === "weather" && result.needsCity) {
    setPendingWeather(sessionId, { request });
  }
  return { reply: result.replyHint ?? "I handled that request.", intent, card: result.card };
}

/**
 * The model picked weather / translate / reminder: keep only what it read
 * from the user (city, phrase and language, task and time) and run the real
 * tool. Its own card and reply are dropped — live, it invented weather.
 */
/** True when both names/codes resolve to the same language ("en", "English"). */
function sameLanguage(a: string, b: string): boolean {
  const x = resolveLanguage(a)?.code ?? a.trim().toLowerCase();
  const y = resolveLanguage(b)?.code ?? b.trim().toLowerCase();
  return x.length > 0 && x === y;
}

/**
 * The model's label is not trusted for menus and tools (C7). Live, a history
 * question about U.S. "aid" came back as intent "help" with the help card;
 * "synonyms in English" came back as a translation English → English. Its
 * spoken answer is kept, as a general reply.
 */
function checkModelRouting<T extends GeminiAgentOutput>(generated: T, text: string): T {
  if (generated.intent === "help" && !isExplicitHelpRequest(text) && !isFeatureQuestion(text)) {
    return { ...generated, intent: "general", card: null };
  }
  if (
    generated.intent === "translate" &&
    generated.card?.type === "translate" &&
    sameLanguage(generated.card.fromLang, generated.card.toLang)
  ) {
    return { ...generated, intent: "general", card: null };
  }
  return generated;
}

async function runToolChosenByModel(
  generated: GeminiAgentOutput,
  text: string,
  sessionId: string,
): Promise<GeminiAgentOutput | null> {
  const { intent, card } = generated;
  if (!TOOL_DATA_INTENTS.has(intent)) return null;

  let slots: Record<string, string> = {};
  if (intent === "weather") {
    const location =
      (card?.type === "weather" ? cleanLocation(card.location) : "") ||
      extractWeatherLocation(text) ||
      "";
    if (!location) {
      setPendingWeather(sessionId, { request: text });
      return { reply: "Which city would you like the weather for?", intent, card: null };
    }
    slots = { location };
  } else if (intent === "translate" && card?.type === "translate") {
    slots = nonEmpty({ original: card.original, toLang: card.toLang, fromLang: card.fromLang });
  } else if (intent === "reminder" && card?.type === "reminder") {
    slots = nonEmpty({ note: card.note, time: card.time });
  }

  const result = await runTool(intent, { userText: text, slots });
  return applyToolResult(intent, result, sessionId, text);
}

export async function handleUtterance(
  input: HandleUtteranceInput,
  log: FastifyBaseLogger,
): Promise<HandleUtteranceResult> {
  const pipelineStart = Date.now();

  assertNotAborted(input.signal, "Agent turn aborted before start");

  // !x Security checklist: hard cap transcript length before it reaches the LLM.
  const trimmed = input.text.trim().slice(0, MAX_INPUT_CHARS);

  if (!trimmed) {
    return buildEmptyReply(input, pipelineStart);
  }

  let text = trimmed;
  let fast = classifyByKeywords(text);
  let rewritten = false;

  // A translation we asked a question about last turn ("Which language?").
  // Handled first: after "What should I translate into French?" the next
  // utterance is the phrase, even "How many days until Christmas?".
  const pending = takePendingTranslation(input.sessionId);
  const fullTranslate = fast?.intent === "translate" && fast.slots.original && fast.slots.toLang;
  let pendingHandled = false;
  if (pending && !fullTranslate) {
    const completed = completePendingTranslation(pending, text, fast);
    pendingHandled = completed !== null;
    if (completed?.kind === "cancel") {
      return buildDirectReply(input, pipelineStart, TRANSLATE_CANCELLED_REPLY, "translate");
    }
    if (completed?.kind === "translate") {
      fast = translateTurn(completed.slots);
    } else if (completed?.kind === "meaning") {
      text = completed.text;
      fast = null;
      rewritten = true;
    }
  }

  // Not when the utterance is itself a translation ("Translate who built you into French").
  if (!pendingHandled && !fullTranslate) {
    // "Who built you?" — a fact about the app, answered from code.
    const identity = identityAnswer(trimmed);
    if (identity) {
      return buildDirectReply(input, pipelineStart, identity, "help");
    }

    // "How many days until New Year?" — counted in code, not by the model.
    const dateReply = dateAnswer(trimmed);
    if (dateReply) {
      return buildDirectReply(input, pipelineStart, dateReply, "general");
    }
  }

  // A weather request we asked "Which city?" about last turn.
  const pendingWeather = takePendingWeather(input.sessionId);
  /** Text the tool parses (the original request when a follow-up completes it). */
  let toolText = text;
  if (pendingWeather && !fast && !rewritten) {
    const place = placeAnswer(text);
    if (place) {
      fast = { intent: "weather", viaFastPath: true, confidence: 1, slots: { location: place } };
      toolText = pendingWeather.request;
    }
  }

  if (!fast && !rewritten) {
    const phrase = parseMeaningWithoutLanguage(text);
    if (phrase && meaningLooksLikeTranslation(phrase, input.context ?? [])) {
      fast = translateTurn({ original: phrase, mode: "meaning-or-translate" });
    }
  }

  let output: GeminiAgentOutput;
  let intent: IntentType;
  let viaFastPath: boolean;
  /** Which LLM produced the reply ("groq/openai/gpt-oss-120b"), or "tool". */
  let source = "tool";

  const conversationSummary = fast?.intent === "summarize" && fast.slots.scope === "conversation";
  const conversation = conversationSummary ? await loadConversation(input, log) : "";

  // A tool may hand the turn back (a "translation" into the same language):
  // then the LLM answers it as a normal question.
  let toolResult: ToolResult | null = null;
  if (fast && !(conversationSummary && !conversation)) {
    toolResult = await runTool(fast.intent, {
      // A conversation summary works on the session transcript, not on the
      // request itself ("summarize everything we discussed").
      userText: conversationSummary ? conversation : toolText,
      slots: fast.slots,
    });
    if (toolResult.handOff) {
      log.info({ intent: fast.intent }, "Tool handed the turn to the LLM");
      fast = null;
      toolResult = null;
    }
  }

  if (fast && conversationSummary && !conversation) {
    viaFastPath = true;
    intent = "summarize";
    output = {
      reply:
        "We have not discussed anything yet in this session, so there is nothing to summarize.",
      intent,
      card: null,
    };
  } else if (fast && toolResult) {
    viaFastPath = true;
    intent = fast.intent;

    output = applyToolResult(intent, toolResult, input.sessionId, toolText);

    log.info(
      { intent, viaFastPath: true, hasCard: toolResult.card !== null },
      "Agent reply (fast path / tool)",
    );
  } else {
    viaFastPath = false;

    const promptText = buildPromptWithContext(text, input.context ?? []);

    const generated = checkModelRouting(
      await safeGenerateAgentOutput(promptText, log, undefined, input.signal),
      text,
    );
    source = generated.source ?? "none";
    const fromTool = await runToolChosenByModel(generated, text, input.sessionId);
    if (fromTool) source = `${source} → ${generated.intent} tool`;
    output = fromTool ?? {
      // Only the model's own words: tool replies are data and stay as they are.
      reply: fitGreetingsToTime(generated.reply, text),
      intent: generated.intent,
      card: generated.card,
    };
    intent = output.intent;

    log.info(
      { intent, viaFastPath: false, hasCard: output.card !== null },
      "Agent reply (slow path / Gemini)",
    );
  }

  assertNotAborted(input.signal, "Agent turn aborted before reply was sent");

  const llmLatencyMs = Math.max(1, Date.now() - pipelineStart);

  const latencyMs: LatencyBreakdown = {
    stt: input.sttLatencyMs,
    llm: llmLatencyMs,
    tts: 0,
    total: Math.max(1, input.sttLatencyMs + llmLatencyMs),
  };

  const reply: AgentReply = {
    text: output.reply,
    intent,
    card: output.card,
    latencyMs,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
  };

  // Tokens are reserved and settled by every LLM call (llm.call.ts generateLlm);
  // tool-only turns use none.

  const pipelineMs = Date.now() - pipelineStart;

  log.info(
    {
      intent,
      viaFastPath,
      hasCard: output.card !== null,
      pipelineMs,
      sttMs: input.sttLatencyMs,
      source,
      textPreview: output.reply.slice(0, 80),
    },
    "Agent pipeline complete",
  );

  return { reply, viaFastPath, pipelineMs };
}

/** A reply decided in code (no tool, no LLM). */
function buildDirectReply(
  input: HandleUtteranceInput,
  startedAt: number,
  text: string,
  intent: IntentType,
): HandleUtteranceResult {
  const llm = Math.max(1, Date.now() - startedAt);
  const reply: AgentReply = {
    text,
    intent,
    card: null,
    latencyMs: { stt: input.sttLatencyMs, llm, tts: 0, total: input.sttLatencyMs + llm },
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
  };
  return { reply, viaFastPath: true, pipelineMs: llm };
}

function buildEmptyReply(input: HandleUtteranceInput, startedAt: number): HandleUtteranceResult {
  const llm = Math.max(1, Date.now() - startedAt);
  const reply: AgentReply = {
    text: "I did not catch that. Could you say it again?",
    intent: "fallback",
    card: null,
    latencyMs: {
      stt: input.sttLatencyMs,
      llm,
      tts: 0,
      total: input.sttLatencyMs + llm,
    },
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
  };
  return { reply, viaFastPath: false, pipelineMs: llm };
}
