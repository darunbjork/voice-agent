import type { FastifyBaseLogger } from "fastify";
import type { AgentReply, GeminiAgentOutput, IntentType } from "@voice-agent/shared-types";
import { classifyByKeywords } from "./intent.classifier.js";
import { safeGenerateAgentOutput } from "./gemini.service.js";
import { runTool } from "./tool.registry.js";

export type HandleUtteranceInput = {
  text: string;
  sessionId: string;
  turnIndex: number;
  sttLatencyMs: number;
};

export type HandleUtteranceResult = {
  reply: AgentReply;
  viaFastPath: boolean;
};

export async function handleUtterance(
  input: HandleUtteranceInput,
  log: FastifyBaseLogger,
): Promise<HandleUtteranceResult> {
  const t0 = Date.now();

  const fast = classifyByKeywords(input.text);

  let output: GeminiAgentOutput;
  let intent: IntentType;
  let viaFastPath: boolean;

  if (fast) {
    viaFastPath = true;
    intent = fast.intent;

    const toolResult = await runTool(fast.intent, {
      userText: input.text,
      slots: fast.slots,
    });

    output = {
      reply: toolResult.replyHint ?? buildFallbackReply(intent, input.text),
      intent,
      card: toolResult.card,
    };

    log.info(
      { intent, viaFastPath: true, hasCard: toolResult.card !== null },
      "Agent reply (fast path / tool)",
    );
  } else {
    viaFastPath = false;
    output = await safeGenerateAgentOutput(input.text, log);
    intent = output.intent;

    log.info(
      { intent, viaFastPath: false, hasCard: output.card !== null },
      "Agent reply (slow path / Gemini)",
    );
  }

  const llmLatencyMs = Date.now() - t0;

  const reply: AgentReply = {
    text: output.reply,
    intent,
    card: output.card,
    latencyMs: {
      stt: input.sttLatencyMs,
      llm: llmLatencyMs,
      tts: 0,
      total: input.sttLatencyMs + llmLatencyMs,
    },
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
  };

  return { reply, viaFastPath };
}

function buildFallbackReply(intent: IntentType, userText: string): string {
  return `I am not sure how to handle that ${intent} request: "${userText}".`;
}
