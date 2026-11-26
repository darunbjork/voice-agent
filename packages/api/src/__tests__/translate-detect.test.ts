// C7 follow-up: with no source language given, the source is detected, not
// assumed to be English. "Translate hej into English" is Swedish → English
// (Swedish visitors try exactly this). Only a detected source equal to the
// target hands the turn to the LLM ("Translate hello into English"). If
// detection fails, the LLM answers (no card).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";

const { toolText } = vi.hoisted(() => ({ toolText: vi.fn() }));
vi.mock("../modules/agent/gemini.tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/agent/gemini.tools.js")>();
  return {
    ...actual,
    generateToolText: (system: string, prompt: string) =>
      toolText.getMockImplementation()
        ? (toolText(system, prompt) as Promise<string>)
        : actual.generateToolText(system, prompt),
  };
});
vi.mock("../modules/agent/gemini.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/agent/gemini.service.js")>();
  return { ...actual, safeGenerateAgentOutput: vi.fn(actual.safeGenerateAgentOutput) };
});

import { handleUtterance } from "../modules/agent/agent.service.js";
import { safeGenerateAgentOutput } from "../modules/agent/gemini.service.js";
import { resetPendingRequests } from "../modules/agent/pending-requests.js";
import { env } from "../env.js";

const log = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
} as unknown as FastifyBaseLogger;

const say = (text: string) =>
  handleUtterance({ text, sessionId: "detect", turnIndex: 0, sttLatencyMs: 0 }, log).then(
    (r) => r.reply,
  );

const saved = { voiceMock: env.VOICE_MOCK, gemini: env.GEMINI_API_KEY };

beforeEach(() => {
  resetPendingRequests();
  toolText.mockReset();
  vi.mocked(safeGenerateAgentOutput).mockClear();
});
afterEach(() => {
  env.VOICE_MOCK = saved.voiceMock;
  env.GEMINI_API_KEY = saved.gemini;
});

describe("mock mode (demo dictionary detects the source)", () => {
  it('"Translate hej into English" → Swedish → English card', async () => {
    const reply = await say("Translate hej into English");
    expect(reply.card).toMatchObject({
      type: "translate",
      original: "hej",
      translated: "hello",
      fromLang: "sv",
      toLang: "en",
    });
    expect(safeGenerateAgentOutput).not.toHaveBeenCalled();
  });

  it('"Translate god morgon to English" → Swedish → English card', async () => {
    const reply = await say("Translate god morgon to English");
    expect(reply.card).toMatchObject({
      type: "translate",
      translated: "good morning",
      fromLang: "sv",
      toLang: "en",
    });
  });

  it('"Translate hello into English" → the LLM, no card', async () => {
    const reply = await say("Translate hello into English");
    expect(reply.card).toBeNull();
    expect(safeGenerateAgentOutput).toHaveBeenCalledTimes(1);
  });

  it('"Translate hello into Spanish" → English → Spanish, unchanged', async () => {
    const reply = await say("Translate hello into Spanish");
    expect(reply.card).toMatchObject({
      type: "translate",
      translated: "hola",
      fromLang: "en",
      toLang: "es",
    });
  });

  it("an unknown phrase into English cannot be detected → the LLM, no card", async () => {
    const reply = await say("Translate kvarg into English");
    expect(reply.card).toBeNull();
    expect(safeGenerateAgentOutput).toHaveBeenCalledTimes(1);
  });
});

describe("live mode (the translation call reports the detected language)", () => {
  beforeEach(() => {
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
  });

  it("detected Swedish → Swedish → English card with the live translation", async () => {
    toolText.mockImplementation(async () => "sv|hi");
    const reply = await say("Translate hej into English");
    expect(reply.card).toMatchObject({
      type: "translate",
      original: "hej",
      translated: "hi",
      fromLang: "sv",
      toLang: "en",
    });
    // The prompt asks for detection; it does not claim a source language.
    const prompt = String(toolText.mock.calls[0]?.[1]);
    expect(prompt).not.toMatch(/from English/i);
  });

  it("detected English into English → the LLM, no card", async () => {
    toolText.mockImplementation(async () => "en|hello");
    vi.mocked(safeGenerateAgentOutput).mockResolvedValueOnce({
      reply: "Hello is already English.",
      intent: "general",
      card: null,
    });
    const reply = await say("Translate hello into English");
    expect(reply.card).toBeNull();
    expect(reply.text).toBe("Hello is already English.");
  });

  it("a reply without a detected language falls back to the LLM when the dictionary cannot tell", async () => {
    toolText.mockImplementation(async () => "something unparseable");
    vi.mocked(safeGenerateAgentOutput).mockResolvedValueOnce({
      reply: "Kvarg is Swedish for quark.",
      intent: "general",
      card: null,
    });
    const reply = await say("Translate kvarg into English");
    expect(reply.card).toBeNull();
    expect(safeGenerateAgentOutput).toHaveBeenCalledTimes(1);
  });

  it("an explicit source is used as given (no detection)", async () => {
    toolText.mockImplementation(async () => "hej");
    const reply = await say("Translate hello from English to Swedish");
    expect(reply.card).toMatchObject({ type: "translate", fromLang: "en", toLang: "sv" });
  });
});
