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

export function mockGeminiOutput(intent: IntentType = "weather"): GeminiAgentOutput {
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
        reply: "I can help with weather, reminders, translation, summaries and more.",
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

/**
 * Short decaying tone as raw 16 kHz 16-bit mono PCM.
 * Matches the live ElevenLabs output format so the player
 * can consume mock and live chunks identically.
 */
export function mockTtsChunk(sequenceNum: number): {
  audio: ArrayBuffer;
  sequenceNum: number;
} {
  const sampleRate = 16_000;
  const durationSec = 0.08;
  const numSamples = Math.floor(sampleRate * durationSec);
  const buffer = new ArrayBuffer(numSamples * 2);
  const view = new DataView(buffer);
  const freq = 440 + sequenceNum * 60;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 12);
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.3;
    const int16 = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
    view.setInt16(i * 2, int16, true);
  }

  return { audio: buffer, sequenceNum };
}
