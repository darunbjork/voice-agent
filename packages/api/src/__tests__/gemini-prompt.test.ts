import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import {
  currentDateTimeLine,
  withCurrentDate,
  generateToolText,
  GEMINI_THINKING_CONFIG,
} from "../modules/agent/gemini.tools.js";
import {
  generateAgentOutput,
  safeGenerateAgentOutput,
  parseAndValidate,
  GeminiParseError,
  SYSTEM_PROMPT,
} from "../modules/agent/gemini.service.js";
import {
  GEMINI_AGENT_RESPONSE_JSON_SCHEMA,
  GeminiAgentOutputSchema,
  IntentTypeSchema,
} from "../modules/agent/gemini.schema.js";
import { mockGeminiOutput } from "../utils/voice-mock.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent: generateContentMock };
    },
  };
});

type LogCall = [Record<string, unknown>, string];
function recordingLogger() {
  const calls: Record<"info" | "warn" | "error", LogCall[]> = { info: [], warn: [], error: [] };
  const log = {
    info: (o: Record<string, unknown>, m: string) => calls.info.push([o, m]),
    warn: (o: Record<string, unknown>, m: string) => calls.warn.push([o, m]),
    error: (o: Record<string, unknown>, m: string) => calls.error.push([o, m]),
    debug: () => undefined,
    child: () => log,
  };
  return { log: log as unknown as FastifyBaseLogger, calls };
}

const lastConfig = (): Record<string, unknown> =>
  (generateContentMock.mock.calls.at(-1)?.[0] as { config: Record<string, unknown> }).config;

function reply(body: unknown, finishReason = "STOP") {
  return {
    text: typeof body === "string" ? body : JSON.stringify(body),
    candidates: [{ finishReason }],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 },
  };
}

describe("current date line", () => {
  it("formats weekday, date and 24h time in Europe/Stockholm (winter, CET)", () => {
    expect(currentDateTimeLine(new Date("2026-11-20T14:42:00Z"))).toBe(
      "Current date and time: Friday, 20 November 2026, 15:42 (Europe/Stockholm)",
    );
  });

  it("follows Stockholm daylight saving time (summer, CEST)", () => {
    expect(currentDateTimeLine(new Date("2026-07-01T22:30:00Z"))).toBe(
      "Current date and time: Thursday, 2 July 2026, 00:30 (Europe/Stockholm)",
    );
  });

  it("withCurrentDate prefixes the system prompt", () => {
    const now = new Date("2026-11-20T14:42:00Z");
    expect(withCurrentDate("SYS", now)).toBe(`${currentDateTimeLine(now)}\n\nSYS`);
  });
});

describe("Gemini request configuration", () => {
  const saved = { mock: env.VOICE_MOCK, key: env.GEMINI_API_KEY };

  beforeEach(() => {
    resetAllCircuits();
    generateContentMock.mockReset();
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T14:42:00Z"));
  });

  afterEach(() => {
    env.VOICE_MOCK = saved.mock;
    env.GEMINI_API_KEY = saved.key;
    vi.useRealTimers();
  });

  it("agent calls carry the date, minimal thinking and the JSON response schema", async () => {
    generateContentMock.mockResolvedValue(
      reply({ reply: "Today is Friday, 20 November 2026.", intent: "general", card: null }),
    );
    await generateAgentOutput("What day is it today?", recordingLogger().log);

    const config = lastConfig();
    expect(config.systemInstruction).toBe(
      `Current date and time: Friday, 20 November 2026, 15:42 (Europe/Stockholm)\n\n${SYSTEM_PROMPT}`,
    );
    expect(config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toBe(GEMINI_AGENT_RESPONSE_JSON_SCHEMA);
  });

  it("tool calls (translate/summarize) carry the date and minimal thinking", async () => {
    generateContentMock.mockResolvedValue({ text: "god natt" });
    await generateToolText("Translate.", "goodnight");

    const config = lastConfig();
    expect(config.systemInstruction).toMatch(
      /^Current date and time: Friday, 20 November 2026, 15:42 \(Europe\/Stockholm\)\n\nTranslate\.$/,
    );
    expect(config.thinkingConfig).toEqual(GEMINI_THINKING_CONFIG);
  });

  it("logs finishReason and usage for every response", async () => {
    generateContentMock.mockResolvedValue(
      reply({ reply: "50 states.", intent: "general", card: null }),
    );
    const { log, calls } = recordingLogger();
    await generateAgentOutput("How many states does the USA have?", log);
    expect(calls.info.find(([, m]) => m === "LLM response")?.[0]).toMatchObject({
      provider: "gemini",
      finishReason: "STOP",
      usage: { promptTokenCount: 300 },
    });
  });

  it("a truncated reply surfaces finishReason on the parse error and in the fallback log", async () => {
    generateContentMock.mockResolvedValue(reply('{"reply": "The United St', "MAX_TOKENS"));
    const { log, calls } = recordingLogger();

    const out = await safeGenerateAgentOutput("How many states does the USA have?", log);

    expect(out.intent).toBe("fallback");
    const warn = calls.warn.find(([, m]) => m === "Gemini parse failure — using fallback");
    expect(warn?.[0].finishReason).toBe("MAX_TOKENS");
    expect(calls.error.some(([o]) => o.finishReason === "MAX_TOKENS")).toBe(true);
  });

  it("answers a general question instead of falling back", async () => {
    generateContentMock.mockResolvedValue(
      reply({ reply: "The United States has 50 states.", intent: "general", card: null }),
    );
    const out = await safeGenerateAgentOutput(
      "How many states does the USA have?",
      recordingLogger().log,
    );
    expect(out).toEqual({
      reply: "The United States has 50 states.",
      intent: "general",
      card: null,
    });
  });
});

describe("validation", () => {
  it("general is a valid intent", () => {
    expect(IntentTypeSchema.options).toContain("general");
    expect(
      GeminiAgentOutputSchema.safeParse({ reply: "50.", intent: "general", card: null }).success,
    ).toBe(true);
  });

  it("the response JSON schema allows exactly the intents and card types Zod accepts", () => {
    const schema = GEMINI_AGENT_RESPONSE_JSON_SCHEMA;
    expect(schema.properties.intent.enum).toEqual(IntentTypeSchema.options);
    const cardTypes = schema.properties.card.anyOf.flatMap((c) =>
      "properties" in c ? c.properties.type.enum : [],
    );
    expect(cardTypes).toEqual(["weather", "reminder", "translate", "summary", "help"]);
  });

  it("keeps the spoken reply and drops a card with an invented type (seen live)", () => {
    // Raw output from production logs: card.type "translation" is not a card type.
    const raw = JSON.stringify({
      reply: "Goodnight in Swedish is god natt.",
      intent: "translate",
      card: { type: "translation", source: "goodnight", target: "god natt", language: "Swedish" },
    });
    const { log, calls } = recordingLogger();
    expect(parseAndValidate(raw, log, "STOP")).toEqual({
      reply: "Goodnight in Swedish is god natt.",
      intent: "translate",
      card: null,
    });
    expect(calls.warn[0]?.[1]).toBe("Gemini card failed validation — dropping card, keeping reply");
  });

  it("still rejects output without a usable reply", () => {
    const raw = JSON.stringify({ reply: "", intent: "general", card: null });
    expect(() => parseAndValidate(raw, recordingLogger().log, "STOP")).toThrow(GeminiParseError);
  });

  it("mock mode has a general reply", () => {
    expect(mockGeminiOutput("general")).toMatchObject({ intent: "general", card: null });
  });
});
