import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env, envSchema } from "../env.js";
import { GEMINI_MODEL_ID, generateToolText } from "../modules/agent/gemini.tools.js";
import { generateAgentOutput } from "../modules/agent/gemini.service.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";

const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
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

const base = { DATABASE_URL: "postgresql://x", JWT_SECRET: "x".repeat(32) };

describe("Gemini model selection", () => {
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

  it("defaults to gemini-3.1-flash-lite-preview", () => {
    expect(envSchema.parse(base).GEMINI_MODEL).toBe("gemini-3.1-flash-lite-preview");
  });

  it("is overridable via GEMINI_MODEL", () => {
    expect(envSchema.parse({ ...base, GEMINI_MODEL: "gemini-x" }).GEMINI_MODEL).toBe("gemini-x");
  });

  it("rejects an empty GEMINI_MODEL", () => {
    expect(envSchema.safeParse({ ...base, GEMINI_MODEL: "" }).success).toBe(false);
  });

  it("GEMINI_MODEL_ID comes from env", () => {
    expect(GEMINI_MODEL_ID).toBe(env.GEMINI_MODEL);
  });

  it("tool calls send the configured model", async () => {
    generateContentMock.mockResolvedValue({ text: "hej" });
    await generateToolText("system", "hello");
    expect(generateContentMock.mock.calls[0]?.[0]?.model).toBe(env.GEMINI_MODEL);
  });

  it("agent calls send the configured model", async () => {
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ reply: "Hello there.", intent: "fallback", card: null }),
    });
    await generateAgentOutput("hello", silentLogger);
    expect(generateContentMock.mock.calls[0]?.[0]?.model).toBe(env.GEMINI_MODEL);
  });
});

describe("ElevenLabs voice default", () => {
  it("defaults to the premade free-plan voice (Lily)", () => {
    expect(envSchema.parse(base).ELEVENLABS_VOICE_ID).toBe("pFZP5JQG7iQjIQuC4Bku");
  });

  it("is overridable via ELEVENLABS_VOICE_ID", () => {
    expect(envSchema.parse({ ...base, ELEVENLABS_VOICE_ID: "abc" }).ELEVENLABS_VOICE_ID).toBe(
      "abc",
    );
  });
});
