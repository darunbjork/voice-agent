// Reminders: task and time come from structured output {task, time} (live)
// or the pattern parser (mock / LLM down), and spoken clock times
// ("fourteen thirty") are understood. Times are Europe/Stockholm.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { env } from "../env.js";
import { normaliseSpokenTimes } from "../modules/agent/spoken-time.js";
import { extractReminderDetails, parseSchedule } from "../modules/agent/reminder-parser.js";
import { extractReminder } from "../modules/agent/reminder-extract.js";
import { reminderTool } from "../modules/agent/tools/reminder.tool.js";
import { closePrisma } from "../utils/db.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

describe("normaliseSpokenTimes", () => {
  it.each([
    ["remind me at fourteen thirty to call mom", "remind me at 14:30 to call mom"],
    ["at fourteen fifteen", "at 14:15"],
    ["at nine oh five", "at 9:05"],
    ["at half past two pm", "at 2:30 pm"],
    ["at quarter past three", "at 3:15"],
    ["at a quarter to four", "at 3:45"],
    ["at three o'clock", "at 3:00"],
    ["at seven pm", "at 7 pm"],
    ["at twenty two forty five", "at 22:45"],
    ["at 14.30", "at 14:30"],
    ["at noon", "at 12:00"],
    ["at midnight", "at 0:00"],
    ["fourteen thirty tomorrow", "14:30 tomorrow"],
  ])("%j → %j", (spoken, expected) => {
    expect(normaliseSpokenTimes(spoken)).toBe(expected);
  });

  it.each(["I have two cats", "call one friend", "buy five apples at the shop"])(
    "leaves %j alone",
    (text) => {
      expect(normaliseSpokenTimes(text)).toBe(text);
    },
  );
});

describe("pattern parser understands spoken times", () => {
  it.each([
    ["Remind me at fourteen thirty to call mom", "call mom", "at 14:30"],
    ["Remind me to stretch at quarter past three", "stretch", "at 3:15"],
    [
      "Remind me tomorrow at nine oh five to send the invoice",
      "send the invoice",
      "tomorrow at 9:05",
    ],
  ])("%j → note %j, time %j", (text, note, time) => {
    expect(extractReminderDetails(text)).toEqual({ note, time });
  });
});

describe("parseSchedule is in Stockholm time", () => {
  /** Saturday 21 Nov 2026, 11:00 in Stockholm (UTC+1). */
  const now = new Date("2026-11-21T10:00:00Z");

  it.each([
    ["at 14:30", "2026-11-21T13:30:00.000Z"],
    ["at 2:30 pm", "2026-11-21T13:30:00.000Z"],
    ["14:30", "2026-11-21T13:30:00.000Z"],
    ["tomorrow at 9", "2026-11-22T08:00:00.000Z"],
    ["at 10", "2026-11-22T09:00:00.000Z"], // already past today → tomorrow
    ["Monday", "2026-11-23T08:00:00.000Z"],
  ])("%j → %s", (time, iso) => {
    expect(parseSchedule(time, now)?.toISOString()).toBe(iso);
  });

  it("uses summer time (UTC+2) in summer", () => {
    expect(parseSchedule("at 14:30", new Date("2026-06-10T08:00:00Z"))?.toISOString()).toBe(
      "2026-06-10T12:30:00.000Z",
    );
  });
});

describe("structured reminder extraction (live)", () => {
  const saved = {
    mock: env.VOICE_MOCK,
    key: env.GEMINI_API_KEY,
    fallback: env.GEMINI_FALLBACK_MODEL,
  };

  beforeEach(() => {
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
    env.GEMINI_FALLBACK_MODEL = "";
    generateContentMock.mockReset();
    resetAllCircuits();
    resetUsageMemory();
  });
  afterEach(() => {
    env.VOICE_MOCK = saved.mock;
    env.GEMINI_API_KEY = saved.key;
    env.GEMINI_FALLBACK_MODEL = saved.fallback;
  });
  afterAll(async () => {
    await closePrisma();
  });

  const llmReturns = (json: unknown) =>
    generateContentMock.mockResolvedValue({
      text: typeof json === "string" ? json : JSON.stringify(json),
      candidates: [{ finishReason: "STOP" }],
    });

  it("uses the model's {task, time} and asks it for structured output", async () => {
    llmReturns({ task: "call mom", time: "14:30" });
    const r = await extractReminder("remind me that at fourteen thirty I really should call mom");
    expect(r).toEqual({ note: "call mom", time: "at 14:30" });
    const config = generateContentMock.mock.calls[0]?.[0]?.config as { responseMimeType?: string };
    expect(config.responseMimeType).toBe("application/json");
  });

  it("keeps day words from the model", async () => {
    llmReturns({ task: "send the invoice", time: "tomorrow 09:05" });
    expect(await extractReminder("remind me tomorrow at nine oh five to send the invoice")).toEqual(
      {
        note: "send the invoice",
        time: "tomorrow at 09:05",
      },
    );
  });

  it("falls back to the pattern parser on invalid model output", async () => {
    llmReturns({ task: 42, when: "soon" });
    expect(await extractReminder("Remind me at fourteen thirty to call mom")).toEqual({
      note: "call mom",
      time: "at 14:30",
    });
  });

  it("the reminder tool saves the extracted task and time", async () => {
    llmReturns({ task: "water the plants", time: "18:00" });
    const r = await reminderTool({
      userText: "remind me eighteen hundred to water the plants",
      slots: {},
    });
    expect(r.card).toEqual({ type: "reminder", note: "water the plants", time: "at 18:00" });
  });
});
