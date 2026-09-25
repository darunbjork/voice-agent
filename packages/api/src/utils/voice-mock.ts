// packages/api/src/utils/voice-mock.ts
// Deterministic mocks for the VOICE_MOCK=true path (docs/cost.md, Section 4).
// Zero network calls — fixed fixtures only.

import type {
  AgentReply,
  GeminiAgentOutput,
  IntentType,
  LatencyBreakdown,
  ResponseCard,
} from "@voice-agent/shared-types";

const MOCK_LATENCY: LatencyBreakdown = {
  stt: 42,
  llm: 110,
  tts: 85,
  total: 237,
};

export function mockTranscriptFinal(text?: string): {
  text: string;
  latencyMs: number;
} {
  return {
    text: text ?? "What is the weather in Stockholm?",
    latencyMs: MOCK_LATENCY.stt,
  };
}

export function mockGeminiOutput(
  intent: IntentType = "weather",
): GeminiAgentOutput {
  switch (intent) {
    case "weather":
      return {
        reply: "It is 22 degrees and partly cloudy in Stockholm.",
        intent,
        card: {
          type: "weather",
          icon: "☀️",
          temp: "22°C",
          desc: "Partly cloudy",
          humidity: "55%",
          wind: "12 km/h",
          location: "Stockholm",
        },
      };
    case "reminder":
      return {
        reply: "Okay, I have set a reminder to call the recruiter tomorrow at 10.",
        intent,
        card: {
          type: "reminder",
          note: "Call the recruiter",
          time: "tomorrow at 10:00",
        },
      };
    case "translate":
      return {
        reply: "Hello world in Swedish is Hej världen.",
        intent,
        card: {
          type: "translate",
          original: "Hello world",
          translated: "Hej världen",
          fromLang: "en",
          toLang: "sv",
        },
      };
    case "summarize":
      return {
        reply: "Here are the three main points from what you said.",
        intent,
        card: {
          type: "summary",
          points: ["Point one", "Point two", "Point three"],
          source: "user utterance",
        },
      };
    case "help":
      return {
        reply:
          "I can help with weather, reminders, translation, summaries and more.",
        intent,
        card: {
          type: "help",
          commands: [
            { name: "weather", description: "Current weather for a city" },
            { name: "reminder", description: "Set a quick reminder" },
            { name: "translate", description: "Translate short phrases" },
          ],
        },
      };
    case "fallback":
      return {
        reply: "I am not sure I understood. Could you rephrase that?",
        intent,
        card: null,
      };
  }
}

export function mockAgentReply(
  sessionId: string,
  turnIndex: number,
  intent: IntentType = "weather",
): AgentReply {
  const output = mockGeminiOutput(intent);
  const card: ResponseCard | null = output.card;

  return {
    text: output.reply,
    intent: output.intent,
    card,
    latencyMs: MOCK_LATENCY,
    sessionId,
    turnIndex,
  };
}

export function mockTtsChunk(sequenceNum: number): {
  audio: ArrayBuffer;
  sequenceNum: number;
} {
  // Canonical 44-byte WAV header: 16-bit mono PCM, 16 kHz, 0-length data chunk.
  const header = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x00, 0x00, 0x00, 0x00,
  ]);

  return { audio: header.slice().buffer, sequenceNum };
}
