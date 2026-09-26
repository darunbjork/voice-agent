import type { FastifyBaseLogger } from "fastify";
import type { AgentReply, IntentType } from "@voice-agent/shared-types";
import { classifyIntent } from "./intent.classifier.js";
import { mockAgentReply } from "../../utils/voice-mock.js";

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
  const classification = await classifyIntent(input.text, log);
  const llmLatencyMs = Date.now() - t0;

  const base = mockAgentReply(input.sessionId, input.turnIndex, classification.intent);

  const reply: AgentReply = {
    ...base,
    text: buildAck(classification.intent, input.text, classification.slots),
    latencyMs: {
      stt: input.sttLatencyMs,
      llm: llmLatencyMs,
      tts: 0,
      total: input.sttLatencyMs + llmLatencyMs,
    },
  };

  return { reply, viaFastPath: classification.viaFastPath };
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
      return `I heard "${userText}". I am not sure how to help with that yet.`;
  }
}
