import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import {
  safeGenerateAgentOutput,
  GeminiParseError,
  generateAgentOutput,
} from "../modules/agent/gemini.service.js";
import { getCircuitSnapshot, resetAllCircuits } from "../utils/circuit-breaker.js";

const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

const silentLogger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger;

describe("gemini circuit wiring", () => {
  const originalVoiceMock = env.VOICE_MOCK;
  const originalApiKey = env.GEMINI_API_KEY;

  beforeEach(() => {
    resetAllCircuits();
    generateContentMock.mockReset();
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
  });

  afterEach(() => {
    env.VOICE_MOCK = originalVoiceMock;
    env.GEMINI_API_KEY = originalApiKey;
  });

  it("opens after 5 provider failures and then short-circuits", async () => {
    generateContentMock.mockRejectedValue(new Error("upstream 500"));

    for (let i = 0; i < 5; i++) {
      await expect(generateAgentOutput("hello", silentLogger)).rejects.toThrow("upstream 500");
    }

    expect(getCircuitSnapshot("gemini")).toMatchObject({
      state: "open",
      failures: 5,
    });

    const callsBefore = generateContentMock.mock.calls.length;
    const out = await safeGenerateAgentOutput("hello", silentLogger);
    expect(generateContentMock.mock.calls.length).toBe(callsBefore);
    expect(out.intent).toBe("fallback");
    expect(out.reply).toContain("temporarily unable to think");
  });

  it("does not trip the breaker on a parse failure", async () => {
    generateContentMock.mockResolvedValue({ text: "definitely not json" });

    await expect(generateAgentOutput("hello", silentLogger)).rejects.toThrow(GeminiParseError);

    expect(getCircuitSnapshot("gemini")).toMatchObject({
      state: "closed",
      failures: 0,
    });
  });

  it("a successful response clears the failure count", async () => {
    generateContentMock.mockRejectedValue(new Error("upstream 500"));
    await expect(generateAgentOutput("hello", silentLogger)).rejects.toThrow();
    await expect(generateAgentOutput("hello", silentLogger)).rejects.toThrow();
    expect(getCircuitSnapshot("gemini").failures).toBe(2);

    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        reply: "Hello there.",
        intent: "fallback",
        card: null,
      }),
    });
    await generateAgentOutput("hello", silentLogger);

    expect(getCircuitSnapshot("gemini")).toMatchObject({
      state: "closed",
      failures: 0,
    });
  });
});
