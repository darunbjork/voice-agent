import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { GoogleGenAI } from "@google/genai";
import { env } from "../env.js";
import {
  generateWithFallback,
  geminiModels,
  GeminiUnavailableError,
} from "../modules/agent/gemini.call.js";
import { safeGenerateAgentOutput } from "../modules/agent/gemini.service.js";
import { getCircuitSnapshot, resetAllCircuits } from "../utils/circuit-breaker.js";
import { AgentTurnAbortedError } from "../utils/turn-abort.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as unknown as FastifyBaseLogger;

const ai = { models: { generateContent: generateContentMock } } as unknown as GoogleGenAI;
const ok = (text: string) => ({ text, candidates: [{ finishReason: "STOP" }] });
const apiError = (code: number) =>
  Object.assign(new Error(`{"error":{"code":${code},"message":"x","status":"UNAVAILABLE"}}`), {
    status: code,
  });

/** Never settles until its abortSignal fires, like the hung requests seen live. */
function hang(params: { config: { abortSignal: AbortSignal } }): Promise<never> {
  return new Promise((_, reject) => {
    params.config.abortSignal.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

const modelOf = (i: number): string =>
  (generateContentMock.mock.calls[i]?.[0] as { model: string }).model;

beforeEach(() => {
  generateContentMock.mockReset();
  resetAllCircuits();
});

describe("geminiModels", () => {
  const saved = { m: env.GEMINI_MODEL, f: env.GEMINI_FALLBACK_MODEL };
  afterEach(() => {
    env.GEMINI_MODEL = saved.m;
    env.GEMINI_FALLBACK_MODEL = saved.f;
  });

  it("is the primary then the fallback", () => {
    env.GEMINI_MODEL = "primary";
    env.GEMINI_FALLBACK_MODEL = "fallback";
    expect(geminiModels()).toEqual(["primary", "fallback"]);
  });

  it("drops an empty or duplicate fallback", () => {
    env.GEMINI_MODEL = "primary";
    env.GEMINI_FALLBACK_MODEL = "";
    expect(geminiModels()).toEqual(["primary"]);
    env.GEMINI_FALLBACK_MODEL = "primary";
    expect(geminiModels()).toEqual(["primary"]);
  });
});

describe("generateWithFallback", () => {
  const opts = { models: ["primary", "fallback"], attemptTimeoutMs: 200, hedgeAfterMs: 50 };

  it("returns the primary answer without starting the fallback when it is fast", async () => {
    generateContentMock.mockResolvedValue(ok("hi"));
    const { model } = await generateWithFallback(ai, { contents: "x" }, opts);
    expect(model).toBe("primary");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("starts the fallback at once when the primary returns 503", async () => {
    generateContentMock
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce(ok("from fallback"));
    const t = Date.now();
    const { response, model } = await generateWithFallback(ai, { contents: "x" }, opts);
    expect(model).toBe("fallback");
    expect(response.text).toBe("from fallback");
    expect(Date.now() - t).toBeLessThan(50);
  });

  it("hedges: a hung primary is raced by the fallback, which wins, and the primary is aborted", async () => {
    let primarySignal: AbortSignal | undefined;
    generateContentMock.mockImplementationOnce((p) => {
      primarySignal = p.config.abortSignal;
      return hang(p);
    });
    generateContentMock.mockResolvedValueOnce(ok("fallback"));

    const { model } = await generateWithFallback(ai, { contents: "x" }, opts);
    expect(model).toBe("fallback");
    expect(modelOf(0)).toBe("primary");
    expect(modelOf(1)).toBe("fallback");
    expect(primarySignal?.aborted).toBe(true);
  });

  it("gives up with GeminiUnavailableError when every attempt hangs past its timeout", async () => {
    generateContentMock.mockImplementation(hang);
    const t = Date.now();
    const err = await generateWithFallback(ai, { contents: "x" }, opts).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiUnavailableError);
    expect((err as GeminiUnavailableError).failures.map((f) => f.model)).toEqual([
      "primary",
      "fallback",
    ]);
    // primary times out at 200 ms, fallback (started at 50 ms) at 250 ms.
    expect(Date.now() - t).toBeLessThan(600);
  });

  it("flags quota-only failures (429) so they skip the breaker", async () => {
    generateContentMock.mockRejectedValue(apiError(429));
    const err = (await generateWithFallback(ai, { contents: "x" }, opts).catch(
      (e) => e,
    )) as GeminiUnavailableError;
    expect(err.quotaOnly).toBe(true);
  });

  it("aborting the turn cancels the attempts", async () => {
    generateContentMock.mockImplementation(hang);
    const turn = new AbortController();
    const p = generateWithFallback(ai, { contents: "x" }, { ...opts, signal: turn.signal });
    setTimeout(() => turn.abort("barge_in"), 20);
    await expect(p).rejects.toBeInstanceOf(AgentTurnAbortedError);
  });
});

describe("agent replies when Gemini is unavailable", () => {
  const saved = { mock: env.VOICE_MOCK, key: env.GEMINI_API_KEY, f: env.GEMINI_FALLBACK_MODEL };
  beforeEach(() => {
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "k";
    env.GEMINI_FALLBACK_MODEL = "fallback-model";
  });
  afterEach(() => {
    env.VOICE_MOCK = saved.mock;
    env.GEMINI_API_KEY = saved.key;
    env.GEMINI_FALLBACK_MODEL = saved.f;
  });

  it("a 503 on the primary is answered by the fallback (no 'Something went wrong')", async () => {
    generateContentMock
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce(
        ok(JSON.stringify({ reply: "Today is Friday.", intent: "general", card: null })),
      );
    const out = await safeGenerateAgentOutput("What day is today?", silent);
    expect(out.reply).toBe("Today is Friday.");
    expect(modelOf(1)).toBe("fallback-model");
  });

  it("when both models fail the user gets a clear, specific reply and one breaker count", async () => {
    generateContentMock.mockRejectedValue(apiError(503));
    const out = await safeGenerateAgentOutput("How are you?", silent);
    expect(out.reply).toBe(
      "I could not reach my language model just now. Please ask again in a moment.",
    );
    expect(out.reply).not.toContain("Something went wrong");
    expect(getCircuitSnapshot("gemini").failures).toBe(1);
  });

  it("rate limits (429 on every model) do not count toward the breaker", async () => {
    generateContentMock.mockRejectedValue(apiError(429));
    await safeGenerateAgentOutput("How are you?", silent);
    expect(getCircuitSnapshot("gemini").failures).toBe(0);
  });
});
