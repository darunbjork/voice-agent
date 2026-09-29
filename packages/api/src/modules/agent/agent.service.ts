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
  signal?: AbortSignal;
};

export type HandleUtteranceResult = {
  reply: AgentReply;
  viaFastPath: boolean;
  pipelineMs: number;
};

const MAX_INPUT_CHARS = 500;

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

  if (fast) {
    viaFastPath = true;
    intent = fast.intent;

    const toolResult = await runTool(fast.intent, {
      userText: trimmed,
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

    let promptText = trimmed;
    if (input.context && input.context.length > 0) {
      const lines = input.context.map((t) =>
        t.role === "user" ? `User: ${t.text}` : `Agent: ${t.text}`,
      );
      promptText = `${lines.join("\n")}\nUser: ${trimmed}`;
    }

    output = await safeGenerateAgentOutput(promptText, log, undefined, input.signal);
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
