// Live bug: on 21 Nov "How many days until New Year?" was answered "40" by the
// LLM; the correct answer is 41. Day counts are now computed in code, in the
// assistant's time zone (Europe/Stockholm).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { dateAnswer } from "../modules/agent/date-answers.js";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { getDailyUsage, resetUsageMemory } from "../utils/usage-tracker.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

/** Saturday 21 November 2026, 11:00 in Stockholm. */
const NOV_21 = new Date("2026-11-21T10:00:00Z");

describe("dateAnswer", () => {
  it.each([
    ["How many days until New Year?", "41 days until New Year's Day"],
    ["how many days are left until new years", "41 days until New Year's Day"],
    ["Days until New Year's Eve?", "40 days until New Year's Eve"],
    ["How many days till Christmas?", "34 days until Christmas Day"],
    ["How many days until Christmas Eve?", "33 days until Christmas Eve"],
    ["How many days until December 31st?", "40 days until 31 December"],
    ["How many days until the 5th of March?", "104 days until 5 March"],
    ["how many days to 1 January", "41 days until 1 January"],
    ["How many days until Friday?", "6 days until Friday"],
    ["How many weeks until Christmas?", "34 days (4 weeks and 6 days) until Christmas Day"],
    ["How long until Halloween?", "344 days until Halloween"],
  ])('"%s" → "%s"', (question, expected) => {
    expect(dateAnswer(question, NOV_21)).toContain(expected);
  });

  it("names the weekday and year of the target date", () => {
    expect(dateAnswer("How many days until New Year?", NOV_21)).toBe(
      "There are 41 days until New Year's Day (Friday, 1 January 2027).",
    );
  });

  it("says 1 day, and today, correctly", () => {
    expect(
      dateAnswer("How many days until Christmas?", new Date("2026-12-24T12:00:00Z")),
    ).toContain("There is 1 day until Christmas Day");
    expect(dateAnswer("How many days until Christmas?", new Date("2026-12-25T12:00:00Z"))).toBe(
      "Christmas Day is today (Friday, 25 December 2026).",
    );
  });

  it("counts in Stockholm time, not UTC", () => {
    // 23:30 UTC on 31 Dec is already 1 January in Stockholm.
    expect(dateAnswer("How many days until New Year?", new Date("2026-12-31T23:30:00Z"))).toBe(
      "New Year's Day is today (Friday, 1 January 2027).",
    );
  });

  it.each([
    "How many days until my birthday?",
    "How many days are in a year?",
    "What day is it?",
    "How many days until the 31st of Smarch?",
  ])('leaves "%s" to the model', (question) => {
    expect(dateAnswer(question, NOV_21)).toBeNull();
  });
});

describe("the agent answers day counts without the LLM", () => {
  const silent = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => silent,
  } as unknown as FastifyBaseLogger;
  const saved = { mock: env.VOICE_MOCK, key: env.GEMINI_API_KEY };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOV_21, toFake: ["Date"] });
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    env.VOICE_MOCK = saved.mock;
    env.GEMINI_API_KEY = saved.key;
  });

  it("21 Nov: days until New Year is 41", async () => {
    const { reply } = await handleUtterance(
      { text: "How many days until New Year?", sessionId: "d", turnIndex: 0, sttLatencyMs: 0 },
      silent,
    );
    expect(reply.text).toContain("41 days");
    expect(reply.intent).toBe("general");
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('"How many days until New Year?" spends no LLM tokens (nothing reserved or counted)', async () => {
    resetUsageMemory();
    await handleUtterance(
      { text: "How many days until New Year?", sessionId: "d2", turnIndex: 0, sttLatencyMs: 0 },
      silent,
    );
    expect(generateContentMock).not.toHaveBeenCalled();
    expect((await getDailyUsage()).tokens).toBe(0);
  });
});
