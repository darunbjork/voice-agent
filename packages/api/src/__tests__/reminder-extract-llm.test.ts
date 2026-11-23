// The {task, time} extraction goes through generateLlm: it reserves and
// settles daily tokens, falls back to Groq when Gemini fails, and — when the
// budget is exhausted or every LLM fails — the pattern parser answers and the
// reminder still works. Reminder confirmations are tool replies, so the
// time-of-day greeting fix-up (B6h) never rewrites them.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { extractReminder } from "../modules/agent/reminder-extract.js";
import { reminderTool } from "../modules/agent/tools/reminder.tool.js";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { fitGreetingsToTime } from "../modules/agent/time-of-day.js";
import { GROQ_BASE_URL } from "../modules/agent/groq.client.js";
import { getDailyUsage, incrementUsage, resetUsageMemory } from "../utils/usage-tracker.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { closePrisma } from "../utils/db.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));
vi.mock("../modules/agent/time-of-day.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/agent/time-of-day.js")>();
  return { ...actual, fitGreetingsToTime: vi.fn(actual.fitGreetingsToTime) };
});

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as unknown as FastifyBaseLogger;

const saved = {
  mock: env.VOICE_MOCK,
  key: env.GEMINI_API_KEY,
  fallback: env.GEMINI_FALLBACK_MODEL,
  groq: env.GROQ_API_KEY,
  cap: env.DAILY_MAX_TOKENS,
};

const SPOKEN = "Remind me at fourteen thirty to call mom";
/** What the pattern parser alone makes of SPOKEN. */
const PARSED = { note: "call mom", time: "at 14:30" };

const geminiJson = (json: object, totalTokenCount?: number) => ({
  text: JSON.stringify(json),
  candidates: [{ finishReason: "STOP" }],
  ...(totalTokenCount === undefined ? {} : { usageMetadata: { totalTokenCount } }),
});

beforeEach(() => {
  env.VOICE_MOCK = false;
  env.GEMINI_API_KEY = "test-key";
  env.GEMINI_FALLBACK_MODEL = "";
  env.GROQ_API_KEY = "";
  generateContentMock.mockReset();
  vi.mocked(fitGreetingsToTime).mockClear();
  resetUsageMemory();
  resetAllCircuits();
});

afterEach(() => {
  Object.assign(env, {
    VOICE_MOCK: saved.mock,
    GEMINI_API_KEY: saved.key,
    GEMINI_FALLBACK_MODEL: saved.fallback,
    GROQ_API_KEY: saved.groq,
    DAILY_MAX_TOKENS: saved.cap,
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(async () => {
  await closePrisma();
});

describe("reminder extraction goes through generateLlm", () => {
  it("reserves tokens before the call and settles to the provider's usage", async () => {
    let tokensDuringCall = -1;
    generateContentMock.mockImplementation(async () => {
      tokensDuringCall = (await getDailyUsage()).tokens;
      return geminiJson({ task: "call mom", time: "14:30" }, 77);
    });

    expect(await extractReminder(SPOKEN)).toEqual({ note: "call mom", time: "at 14:30" });
    expect(tokensDuringCall).toBeGreaterThan(300); // prompt estimate + reply reserve
    expect((await getDailyUsage()).tokens).toBe(77);
  });

  it("falls back to Groq when Gemini fails", async () => {
    env.GROQ_API_KEY = "test-groq-key";
    generateContentMock.mockRejectedValue(
      Object.assign(new Error('{"error":{"code":503,"message":"high demand"}}'), { status: 503 }),
    );
    const groqUrls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(GROQ_BASE_URL)) return realFetch(input, init);
      groqUrls.push(url);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ task: "call mom", time: "15:45" }) } }],
          usage: { prompt_tokens: 300, completion_tokens: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    expect(await extractReminder(SPOKEN)).toEqual({ note: "call mom", time: "at 15:45" });
    expect(groqUrls).toHaveLength(1);
  });

  it("over the daily budget: the provider is not called and the pattern parser answers", async () => {
    env.DAILY_MAX_TOKENS = 1000;
    await incrementUsage({ tokens: 1000 });

    expect(await extractReminder(SPOKEN)).toEqual(PARSED);
    expect(generateContentMock).not.toHaveBeenCalled();
    expect((await getDailyUsage()).tokens).toBe(1000);
  });

  it("over the daily budget the reminder is still saved", async () => {
    env.DAILY_MAX_TOKENS = 1000;
    await incrementUsage({ tokens: 1000 });

    const r = await reminderTool({ userText: SPOKEN, slots: {} });
    expect(r.card).toEqual({ type: "reminder", ...PARSED });
    expect(r.replyHint).toMatch(/^I saved a reminder to call mom at 14:30\./);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("when every LLM fails, the pattern parser answers and nothing stays reserved", async () => {
    generateContentMock.mockRejectedValue(new Error("upstream 500"));
    expect(await extractReminder(SPOKEN)).toEqual(PARSED);
    expect((await getDailyUsage()).tokens).toBe(0);
  });
});

describe("reminder confirmations are not rewritten by the greeting fix-up", () => {
  it('at 23:14, "…to have a great day" in a reminder stays as it is', async () => {
    vi.useFakeTimers({ now: new Date("2026-11-21T23:14:00+01:00"), toFake: ["Date"] });
    generateContentMock.mockResolvedValue(
      geminiJson({ task: "tell Anna to have a great day", time: "tomorrow 08:00" }),
    );

    const { reply } = await handleUtterance(
      {
        text: "Remind me tomorrow at eight to tell Anna to have a great day",
        sessionId: "rem-tod",
        turnIndex: 0,
        sttLatencyMs: 0,
      },
      silent,
    );

    expect(reply.intent).toBe("reminder");
    expect(reply.text).toContain("tell Anna to have a great day");
    expect(reply.text).not.toContain("have a good night");
    expect(fitGreetingsToTime).not.toHaveBeenCalled();
  });
});
