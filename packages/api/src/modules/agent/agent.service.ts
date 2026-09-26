import type { FastifyBaseLogger } from "fastify";
import type { AgentReply, GeminiAgentOutput, IntentType } from "@voice-agent/shared-types";
import { classifyByKeywords } from "./intent.classifier.js";
import { mockGeminiOutput } from "../../utils/voice-mock.js";
import { safeGenerateAgentOutput } from "./gemini.service.js";

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
    output = buildFastPathOutput(fast.intent, fast.slots);
    log.info({ intent, viaFastPath: true }, "Agent reply (fast path)");
  } else {
    viaFastPath = false;
    output = await safeGenerateAgentOutput(input.text, log);
    intent = output.intent;
    log.info({ intent, viaFastPath: false }, "Agent reply (slow path / Gemini)");
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

function buildFastPathOutput(intent: IntentType, slots: Record<string, string>): GeminiAgentOutput {
  const base = mockGeminiOutput(intent);
  return {
    reply: buildAck(intent, "", slots),
    intent,
    card: base.card,
  };
}

function buildAck(intent: IntentType, userText: string, slots: Record<string, string>): string {
  switch (intent) {
    case "weather": {
      const loc = slots.location ?? "your location";
      return `Checking the weather for ${loc}.`;
    }
    case "reminder": {
      const note = slots.note ?? "that";
      return `Okay, I will remind you to ${note}.`;
    }
    case "translate": {
      if (slots.original && slots.toLang) {
        return `Translating "${slots.original}" to ${slots.toLang}.`;
      }
      return "Translating that for you.";
    }
    case "summarize":
      return "Here is a quick summary of what you said.";
    case "help":
      return "I can help with weather, reminders, translation, and summaries. What do you need?";
    case "fallback":
    default:
      return userText
        ? `I heard "${userText}". I am not sure how to help with that yet.`
        : "I am not sure how to help with that yet.";
  }
}
