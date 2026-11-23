// Live bug: the agent said "have a great day" at 23:14. LLM greetings and
// sign-offs now fit the time of day in Europe/Stockholm.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { fitGreetingsToTime, partOfDay } from "../modules/agent/time-of-day.js";
import { SYSTEM_PROMPT } from "../modules/agent/gemini.service.js";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { resetPendingRequests } from "../modules/agent/pending-requests.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

// The real fix-up, wrapped so tests can see which replies went through it.
vi.mock("../modules/agent/time-of-day.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/agent/time-of-day.js")>();
  return { ...actual, fitGreetingsToTime: vi.fn(actual.fitGreetingsToTime) };
});

/** Stockholm is UTC+1 in November. */
const at = (stockholmTime: string) => new Date(`2026-11-21T${stockholmTime}:00+01:00`);

describe("partOfDay (Europe/Stockholm)", () => {
  it.each([
    ["06:00", "morning"],
    ["11:59", "morning"],
    ["12:00", "afternoon"],
    ["17:59", "afternoon"],
    ["18:00", "evening"],
    ["21:59", "evening"],
    ["22:00", "night"],
    ["23:14", "night"],
    ["03:00", "night"],
  ])("%s is %s", (time, part) => {
    expect(partOfDay(at(time))).toBe(part);
  });
});

describe("fitGreetingsToTime", () => {
  it.each([
    ["23:14", "Sure, that is all. Have a great day!", "Sure, that is all. Have a good night!"],
    ["20:00", "Glad I could help, have a nice day.", "Glad I could help, have a good evening."],
    ["10:00", "Glad I could help, have a great day.", "Glad I could help, have a great day."],
    ["23:14", "Good morning! How can I help?", "Good evening! How can I help?"],
    ["07:30", "Good evening, what can I do for you?", "Good morning, what can I do for you?"],
    ["15:00", "Good morning! Ready when you are.", "Good afternoon! Ready when you are."],
  ])("at %s: %j → %j", (time, reply, expected) => {
    expect(fitGreetingsToTime(reply, "hello", at(time))).toBe(expected);
  });

  it("leaves a reply about the phrase itself alone", () => {
    expect(
      fitGreetingsToTime("Good morning is a greeting.", "what is good morning", at("23:14")),
    ).toBe("Good morning is a greeting.");
  });

  it('leaves a one-phrase answer ("Good morning.") alone', () => {
    expect(fitGreetingsToTime("Good morning.", "god morgon in English", at("23:14"))).toBe(
      "Good morning.",
    );
  });

  it("leaves the reply alone when the user used that greeting", () => {
    expect(fitGreetingsToTime("Good morning! Up late?", "good morning!", at("23:14"))).toBe(
      "Good morning! Up late?",
    );
  });
});

describe("the system prompt and the agent", () => {
  const silent = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => silent,
  } as unknown as FastifyBaseLogger;
  const saved = { mock: env.VOICE_MOCK, key: env.GEMINI_API_KEY };

  beforeEach(() => {
    vi.useFakeTimers({ now: at("23:14"), toFake: ["Date"] });
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    env.VOICE_MOCK = saved.mock;
    env.GEMINI_API_KEY = saved.key;
  });

  it("the prompt tells the model to fit greetings to the current time", () => {
    expect(SYSTEM_PROMPT).toMatch(/greetings and sign-offs must fit the current time/i);
  });

  it('at 23:14 an LLM "have a great day" is spoken as "have a good night"', async () => {
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        reply: "You are welcome. Have a great day!",
        intent: "general",
        card: null,
      }),
      candidates: [{ finishReason: "STOP" }],
    });
    const { reply } = await handleUtterance(
      { text: "Thanks, that is all", sessionId: "tod", turnIndex: 0, sttLatencyMs: 0 },
      silent,
    );
    expect(reply.text).toBe("You are welcome. Have a good night!");
  });
});

describe("only free LLM replies are rewritten (23:14)", () => {
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
  };
  const fixUp = vi.mocked(fitGreetingsToTime);

  const say = (text: string) =>
    handleUtterance({ text, sessionId: "tod-scope", turnIndex: 0, sttLatencyMs: 0 }, silent).then(
      (r) => r.reply,
    );

  /** Structured agent replies get `agentJson`; plain tool calls (translation) get `toolText`. */
  function llmAnswers(agentJson: object, toolText = "") {
    generateContentMock.mockImplementation(
      async (req: { config?: { responseMimeType?: string } }) => ({
        text:
          req.config?.responseMimeType === "application/json"
            ? JSON.stringify(agentJson)
            : toolText,
        candidates: [{ finishReason: "STOP" }],
      }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: at("23:14"), toFake: ["Date"] });
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
    env.GEMINI_FALLBACK_MODEL = "";
    generateContentMock.mockReset();
    fixUp.mockClear();
    resetPendingRequests();
    resetUsageMemory();
    resetAllCircuits();
  });
  afterEach(() => {
    vi.useRealTimers();
    env.VOICE_MOCK = saved.mock;
    env.GEMINI_API_KEY = saved.key;
    env.GEMINI_FALLBACK_MODEL = saved.fallback;
  });

  it.each(["Who built you?", "How many days until Christmas?"])(
    'direct reply "%s" never goes through the fix-up',
    async (text) => {
      await say(text);
      expect(fixUp).not.toHaveBeenCalled();
      expect(generateContentMock).not.toHaveBeenCalled();
    },
  );

  it("a cancelled translation (direct reply) never goes through the fix-up", async () => {
    await say("Translate to French");
    const reply = await say("never mind");
    expect(reply.text).toMatch(/no translation/i);
    expect(fixUp).not.toHaveBeenCalled();
  });

  it('translating "have a great day" to French at 23:14 keeps the phrase', async () => {
    llmAnswers({ reply: "unused", intent: "general", card: null }, "Passez une bonne journée");
    const reply = await say("Translate have a great day to French");
    expect(reply.intent).toBe("translate");
    expect(reply.card).toMatchObject({ type: "translate", original: "have a great day" });
    expect(reply.text).toBe("have a great day in French is Passez une bonne journée.");
    expect(fixUp).not.toHaveBeenCalled();
  });

  it("a translation the LLM routed to the tool is not rewritten either", async () => {
    llmAnswers(
      {
        reply: "In French: have a great day is passez une bonne journée.",
        intent: "translate",
        card: {
          type: "translate",
          original: "have a great day",
          translated: "",
          fromLang: "",
          toLang: "French",
        },
      },
      "Passez une bonne journée",
    );
    const reply = await say("How do the French wish someone have a great day");
    expect(reply.text).toContain("have a great day");
    expect(reply.text).not.toContain("have a good night");
    expect(fixUp).not.toHaveBeenCalled();
  });

  it("a free LLM reply at 23:14 is rewritten", async () => {
    llmAnswers({ reply: "Happy to help. Have a great day!", intent: "general", card: null });
    const reply = await say("Okay, that is everything for now");
    expect(fixUp).toHaveBeenCalledTimes(1);
    expect(reply.text).toBe("Happy to help. Have a good night!");
  });
});
