// C11 — live: "Remind me to follow up with the recruiter tomorrow" → the card
// and the stored time said "tomorrow", which is wrong the day after. The date
// is now resolved in code (Europe/Stockholm, injected/fake clock), stored and
// shown as an absolute date ("Sat 28 Nov", "Sat 28 Nov, 15:00"); the spoken
// reply stays natural ("tomorrow, Saturday 28 November").
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { env } from "../env.js";
import { resolveReminderWhen } from "../modules/agent/reminder-parser.js";
import { reminderTool } from "../modules/agent/tools/reminder.tool.js";
import { closePrisma, getPrisma } from "../utils/db.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

/** Friday 27 November 2026, 14:00 in Stockholm (CET, UTC+1). */
const FRI_1400 = new Date("2026-11-27T13:00:00Z");

describe("resolveReminderWhen (Europe/Stockholm, injected clock)", () => {
  it.each([
    // [said, display, spoken, instant (UTC)]
    ["tomorrow", "Sat 28 Nov", "tomorrow, Saturday 28 November", "2026-11-28T08:00:00.000Z"],
    [
      "tomorrow at 3",
      "Sat 28 Nov, 15:00",
      "tomorrow, Saturday 28 November, at 15:00",
      "2026-11-28T14:00:00.000Z",
    ],
    [
      "tomorrow at 9",
      "Sat 28 Nov, 09:00",
      "tomorrow, Saturday 28 November, at 09:00",
      "2026-11-28T08:00:00.000Z",
    ],
    ["next Monday", "Mon 30 Nov", "next Monday, 30 November", "2026-11-30T08:00:00.000Z"],
    // Today is Friday: "on Friday" is next week's Friday.
    ["on Friday", "Fri 4 Dec", "on Friday, 4 December", "2026-12-04T08:00:00.000Z"],
    ["in 2 hours", "Fri 27 Nov, 16:00", "in 2 hours, at 16:00", "2026-11-27T15:00:00.000Z"],
    ["in two hours", "Fri 27 Nov, 16:00", "in two hours, at 16:00", "2026-11-27T15:00:00.000Z"],
    ["in 30 minutes", "Fri 27 Nov, 14:30", "in 30 minutes, at 14:30", "2026-11-27T13:30:00.000Z"],
    [
      "tonight",
      "Fri 27 Nov, 20:00",
      "tonight, Friday 27 November, at 20:00",
      "2026-11-27T19:00:00.000Z",
    ],
    [
      "tonight at 9",
      "Fri 27 Nov, 21:00",
      "tonight, Friday 27 November, at 21:00",
      "2026-11-27T20:00:00.000Z",
    ],
    [
      "at 17:30",
      "Fri 27 Nov, 17:30",
      "today, Friday 27 November, at 17:30",
      "2026-11-27T16:30:00.000Z",
    ],
  ])("%j → %j", (said, display, spoken, iso) => {
    const when = resolveReminderWhen(said, FRI_1400);
    expect(when?.display).toBe(display);
    expect(when?.spoken).toBe(spoken);
    expect(when?.at?.toISOString()).toBe(iso);
  });

  it.each([
    ["later today", "later today, Friday 27 November"],
    ["today", "today, Friday 27 November"],
  ])("%j: the date, but no made-up due time", (said, spoken) => {
    const when = resolveReminderWhen(said, FRI_1400);
    expect(when?.display).toBe("Fri 27 Nov");
    expect(when?.spoken).toBe(spoken);
    expect(when?.at).toBeNull();
  });

  it("late evening: 23:30 + 'in 2 hours' is the next day", () => {
    const when = resolveReminderWhen("in 2 hours", new Date("2026-11-27T22:30:00Z"));
    expect(when?.display).toBe("Sat 28 Nov, 01:30");
    expect(when?.spoken).toBe("in 2 hours, at 01:30 on Saturday 28 November");
    expect(when?.at?.toISOString()).toBe("2026-11-28T00:30:00.000Z");
  });

  it("late evening: an earlier clock time today rolls to tomorrow", () => {
    const when = resolveReminderWhen("at 9", new Date("2026-11-27T22:30:00Z"));
    expect(when?.display).toBe("Sat 28 Nov, 09:00");
    expect(when?.spoken).toBe("tomorrow, Saturday 28 November, at 09:00");
  });

  describe("DST boundaries", () => {
    it("spring forward (28 Mar 2027, 02:00 → 03:00): 01:30 + 2 hours is 04:30 local", () => {
      const when = resolveReminderWhen("in 2 hours", new Date("2027-03-28T00:30:00Z"));
      expect(when?.at?.toISOString()).toBe("2027-03-28T02:30:00.000Z");
      expect(when?.display).toBe("Sun 28 Mar, 04:30");
    });

    it("'tomorrow at 3' across spring forward is 15:00 CEST (13:00 UTC)", () => {
      const when = resolveReminderWhen("tomorrow at 3", new Date("2027-03-27T11:00:00Z"));
      expect(when?.at?.toISOString()).toBe("2027-03-28T13:00:00.000Z");
      expect(when?.display).toBe("Sun 28 Mar, 15:00");
    });

    it("'tomorrow at 9' across fall back (25 Oct 2026) is 09:00 CET (08:00 UTC)", () => {
      const when = resolveReminderWhen("tomorrow at 9", new Date("2026-10-24T10:00:00Z"));
      expect(when?.at?.toISOString()).toBe("2026-10-25T08:00:00.000Z");
      expect(when?.display).toBe("Sun 25 Oct, 09:00");
    });

    it("fall back: 01:30 CEST + 2 hours is 02:30 CET (the hour 02:00–03:00 repeats)", () => {
      const when = resolveReminderWhen("in 2 hours", new Date("2026-10-24T23:30:00Z"));
      expect(when?.at?.toISOString()).toBe("2026-10-25T01:30:00.000Z");
      expect(when?.display).toBe("Sun 25 Oct, 02:30");
    });
  });

  it.each(["in a while", "soon", "next week", "at 25pm"])("%j cannot be resolved", (said) => {
    expect(resolveReminderWhen(said, FRI_1400)).toBeNull();
  });
});

describe("the reminder tool stores and shows the absolute date", () => {
  const saved = { voiceMock: env.VOICE_MOCK, gemini: env.GEMINI_API_KEY };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FRI_1400);
    resetAllCircuits();
    resetUsageMemory();
    generateContentMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    env.VOICE_MOCK = saved.voiceMock;
    env.GEMINI_API_KEY = saved.gemini;
  });
  afterAll(async () => {
    await closePrisma();
  });

  it.each([
    [
      "Remind me to follow up with the recruiter tomorrow",
      "follow up with the recruiter",
      "Sat 28 Nov",
      "tomorrow, Saturday 28 November",
    ],
    [
      "Remind me to call Alex tomorrow at 3",
      "call Alex",
      "Sat 28 Nov, 15:00",
      "tomorrow, Saturday 28 November, at 15:00",
    ],
    ["Remind me to call mom next Monday", "call mom", "Mon 30 Nov", "next Monday, 30 November"],
    ["Remind me to stretch in 2 hours", "stretch", "Fri 27 Nov, 16:00", "in 2 hours, at 16:00"],
    ["Remind me to pay rent on Friday", "pay rent", "Fri 4 Dec", "on Friday, 4 December"],
    [
      "Remind me to take out the trash tonight",
      "take out the trash",
      "Fri 27 Nov, 20:00",
      "tonight, Friday 27 November, at 20:00",
    ],
  ])("mock mode: %j", async (text, note, display, spoken) => {
    const r = await reminderTool({ userText: text, slots: {} });
    expect(r.card).toEqual({ type: "reminder", note, time: display });
    expect(r.replyHint).toContain(spoken);
  });

  it("saved live: timeText is the absolute date, scheduledAt the instant", async () => {
    env.VOICE_MOCK = false; // real save to the local test database; no LLM key → pattern parser
    env.GEMINI_API_KEY = "";
    const note = `follow up with the recruiter ${Date.now()}-${Math.random()}`;
    const r = await reminderTool({ userText: `Remind me to ${note} tomorrow`, slots: {} });
    expect(r.card.time).toBe("Sat 28 Nov");
    expect(r.replyHint).toMatch(/^I saved a reminder to .* tomorrow, Saturday 28 November\./);
    const row = await getPrisma().reminder.findFirst({ where: { note } });
    expect(row?.timeText).toBe("Sat 28 Nov");
    expect(row?.scheduledAt?.toISOString()).toBe("2026-11-28T08:00:00.000Z");
  });

  it("live LLM extraction 'tomorrow at 3' is resolved in code, not by the model", async () => {
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({ task: "call Alex", time: "tomorrow at 3" }),
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { totalTokenCount: 50 },
    });
    const r = await reminderTool({
      userText: "remind me to call Alex tomorrow at three",
      slots: {},
    });
    expect(r.card).toEqual({ type: "reminder", note: "call Alex", time: "Sat 28 Nov, 15:00" });
  });

  it("no time given ('later today') shows today's date, not the relative words", async () => {
    const r = await reminderTool({ userText: "Remind me to water the plants", slots: {} });
    expect(r.card.time).toBe("Fri 27 Nov");
    expect(r.replyHint).toContain("later today, Friday 27 November");
  });

  it("a time that cannot be resolved is kept as said", async () => {
    const r = await reminderTool({
      userText: "Remind me to call mom",
      slots: { time: "next week" },
    });
    expect(r.card.time).toBe("next week");
  });
});
