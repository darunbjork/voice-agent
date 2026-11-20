import type { FastifyBaseLogger } from "fastify";
import type {
  AgentReply,
  GeminiAgentOutput,
  IntentType,
  LatencyBreakdown,
} from "@voice-agent/shared-types";
import { classifyByKeywords } from "./intent.classifier.js";
import { safeGenerateAgentOutput } from "./gemini.service.js";
import { runTool } from "./tool.registry.js";
import { incrementUsage } from "../../utils/usage-tracker.js";
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

const MAX_INPUT_CHARS = 500;
/** Recent conversation sent with a general question (~750 tokens). */
export const MAX_CONTEXT_CHARS = 3000;

/**
 * The current utterance with the recent conversation, newest turns kept, so
 * acronyms resolve from what was said ("MCP" = Model Context Protocol, not a
 * guessed expansion).
 */
export function buildPromptWithContext(text: string, context: SessionContextTurn[]): string {
  const lines = context
    .filter((t) => t.text.trim().length > 0)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text.trim()}`);
  while (lines.length > 0 && lines.join("\n").length > MAX_CONTEXT_CHARS) lines.shift();
  if (lines.length === 0) return text;
  return `Conversation so far:\n${lines.join("\n")}\n\nCurrent message from the user:\n${text}`;
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

  const fast = classifyByKeywords(trimmed);

  let output: GeminiAgentOutput;
  let intent: IntentType;
  let viaFastPath: boolean;
  /** Which LLM produced the reply ("groq/openai/gpt-oss-120b"), or "tool". */
  let source = "tool";

  const conversationSummary = fast?.intent === "summarize" && fast.slots.scope === "conversation";
  const conversation = conversationSummary ? await loadConversation(input, log) : "";

  if (fast && conversationSummary && !conversation) {
    viaFastPath = true;
    intent = "summarize";
    output = {
      reply:
        "We have not discussed anything yet in this session, so there is nothing to summarize.",
      intent,
      card: null,
    };
  } else if (fast) {
    viaFastPath = true;
    intent = fast.intent;

    const toolResult = await runTool(fast.intent, {
      // A conversation summary works on the session transcript, not on the
      // request itself ("summarize everything we discussed").
      userText: conversationSummary ? conversation : trimmed,
      slots: fast.slots,
    });

    output = {
      reply: toolResult.replyHint ?? "I handled that request.",
      intent,
      card: toolResult.card,
    };

    log.info(
      { intent, viaFastPath: true, hasCard: toolResult.card !== null },
      "Agent reply (fast path / tool)",
    );
  } else {
    viaFastPath = false;

    const promptText = buildPromptWithContext(trimmed, input.context ?? []);

    const generated = await safeGenerateAgentOutput(promptText, log, undefined, input.signal);
    source = generated.source ?? "none";
    output = { reply: generated.reply, intent: generated.intent, card: generated.card };
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

  const approxTokens = Math.ceil(trimmed.length / 4) + Math.ceil(output.reply.length / 4) + 100;
  await incrementUsage({ tokens: approxTokens });

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
