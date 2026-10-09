import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { env } from "../env.js";
import { weatherTool, mapWeatherCode } from "../modules/agent/tools/weather.tool.js";
import { translateTool } from "../modules/agent/tools/translate.tool.js";
import { summarizeTool } from "../modules/agent/tools/summarize.tool.js";
import { reminderTool, parseSchedule } from "../modules/agent/tools/reminder.tool.js";
import { getPrisma, closePrisma } from "../utils/db.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";

const originalVoiceMock = env.VOICE_MOCK;
const originalGeminiKey = env.GEMINI_API_KEY;

function goLive(): void {
  env.VOICE_MOCK = false;
  env.GEMINI_API_KEY = "test-gemini-key";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  env.VOICE_MOCK = originalVoiceMock;
  env.GEMINI_API_KEY = originalGeminiKey;
  vi.unstubAllGlobals();
  resetAllCircuits();
});

afterAll(async () => {
  await closePrisma();
});

describe("weather tool (live mode, stubbed Open-Meteo)", () => {
  it("builds a real card from geocoding + forecast responses", async () => {
    goLive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("geocoding-api.open-meteo.com")) {
          return jsonResponse({
            results: [{ name: "Berlin", country: "Germany", latitude: 52.52, longitude: 13.41 }],
          });
        }
        if (url.includes("api.open-meteo.com")) {
          return jsonResponse({
            current: {
              temperature_2m: 21.6,
              relative_humidity_2m: 61,
              wind_speed_10m: 14.2,
              weather_code: 3,
            },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const r = await weatherTool({
      userText: "What is the weather in Berlin?",
      slots: { location: "Berlin" },
    });

    expect(r.card.location).toBe("Berlin, Germany");
    expect(r.card.temp).toBe("22°C");
    expect(r.card.desc).toBe("Overcast");
    expect(r.card.humidity).toBe("61%");
    expect(r.card.wind).toBe("14 km/h");
    expect(r.replyHint).toContain("22°C");
    expect(r.replyHint).toContain("Berlin, Germany");
  });

  it("reports an unknown place honestly", async () => {
    goLive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ results: [] })),
    );

    const r = await weatherTool({ userText: "weather", slots: { location: "Gotham" } });
    expect(r.replyHint).toContain("could not find a place called Gotham");
  });

  it("degrades honestly when the weather service is unreachable", async () => {
    goLive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const r = await weatherTool({ userText: "weather", slots: { location: "Oslo" } });
    expect(r.replyHint).toContain("could not reach the weather service");
    expect(r.card.location).toBe("Oslo");
    expect(r.card.desc).toContain("demo data");
    expect(r.replyHint).toContain("demo data");
  });

  it("maps WMO weather codes to icon and description", () => {
    expect(mapWeatherCode(0)).toEqual({ icon: "☀️", desc: "Clear sky" });
    expect(mapWeatherCode(3).desc).toBe("Overcast");
    expect(mapWeatherCode(45).desc).toBe("Fog");
    expect(mapWeatherCode(61).desc).toBe("Rain");
    expect(mapWeatherCode(75).desc).toBe("Snow");
    expect(mapWeatherCode(95).desc).toBe("Thunderstorm");
    expect(mapWeatherCode(999).desc).toBe("Unknown");
  });
});

describe("translate tool (live mode, stubbed Gemini)", () => {
  function stubGemini(text: string): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("generativelanguage.googleapis.com")) {
        return jsonResponse({ candidates: [{ content: { parts: [{ text }], role: "model" } }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("translates through Gemini when live", async () => {
    goLive();
    const fetchMock = stubGemini("Hej världen");
    vi.stubGlobal("fetch", fetchMock);

    const r = await translateTool({
      userText: "Translate hello world in swedish",
      slots: {},
    });
    // Prove the Gemini path ran — not the demo-dictionary fallback.
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("generativelanguage")),
    ).toBe(true);
    expect(r.card.translated).toBe("Hej världen");
    expect(r.replyHint).toBe("hello world in Swedish is Hej världen.");
  });

  it("falls back to the demo dictionary when Gemini fails", async () => {
    goLive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("provider down");
      }),
    );

    const r = await translateTool({
      userText: "Translate hello world in swedish",
      slots: {},
    });
    expect(r.card.translated).toBe("hej världen");
    expect(r.replyHint).toBe("hello world in Swedish is hej världen.");
  });

  it("stays honest for unknown phrases when Gemini fails", async () => {
    goLive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("provider down");
      }),
    );

    const r = await translateTool({
      userText: "Translate quantum chromodynamics in swedish",
      slots: {},
    });
    expect(r.replyHint).toContain("do not have a translation");
  });
});

describe("summarize tool (live mode, stubbed Gemini)", () => {
  it("uses Gemini bullet points and strips the command prefix from the prompt", async () => {
    goLive();
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("generativelanguage.googleapis.com")) {
          bodies.push(String(init?.body ?? ""));
          return jsonResponse({
            candidates: [
              {
                content: {
                  parts: [{ text: "we shipped the API\nfixed the tests\nwrote the docs" }],
                  role: "model",
                },
              },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const r = await summarizeTool({
      userText: "Summarize: we shipped the API, fixed the tests, and wrote the docs.",
      slots: {},
    });

    expect(r.card.points).toEqual(["we shipped the API", "fixed the tests", "wrote the docs"]);
    expect(r.card.source).not.toMatch(/^summarize/i);
    expect(r.replyHint).toBe("Here are 3 key points.");
    expect(bodies[0]).toBeDefined();
    expect(bodies[0]).not.toContain("Summarize:");
  });

  it("falls back to the deterministic splitter when Gemini fails", async () => {
    goLive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("provider down");
      }),
    );

    const r = await summarizeTool({ userText: "One. Two. Three.", slots: {} });
    expect(r.card.points).toEqual(["One.", "Two.", "Three."]);
  });
});

describe("reminder tool (live mode, real database)", () => {
  it("persists a reminder and confirms it", async () => {
    goLive();
    const r = await reminderTool({
      userText: "Remind me to water the plants tomorrow",
      slots: {},
    });
    expect(r.card.note).toBe("water the plants");
    expect(r.replyHint).toBe("Okay, I will remind you to water the plants tomorrow.");

    const prisma = getPrisma();
    const row = await prisma.reminder.findFirst({
      where: { note: "water the plants" },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new Error("reminder row was not persisted");
    expect(row.timeText.toLowerCase()).toContain("tomorrow");
    expect(row.scheduledAt).not.toBeNull();

    await prisma.reminder.delete({ where: { id: row.id } });
  });
});

describe("parseSchedule", () => {
  const now = new Date("2026-10-04T10:00:00");

  it("schedules bare 'tomorrow' for 09:00 the next day", () => {
    const d = parseSchedule("tomorrow", now);
    expect(d).not.toBeNull();
    expect(d?.getDate()).toBe(5);
    expect(d?.getHours()).toBe(9);
  });

  it("parses 'tomorrow at 5pm'", () => {
    const d = parseSchedule("tomorrow at 5pm", now);
    expect(d).not.toBeNull();
    expect(d?.getDate()).toBe(5);
    expect(d?.getHours()).toBe(17);
  });

  it("schedules a weekday for its next occurrence at 09:00", () => {
    const d = parseSchedule("Monday", now);
    expect(d).not.toBeNull();
    expect(d?.getDay()).toBe(1);
    expect(d?.getDate()).toBe(5);
    expect(d?.getHours()).toBe(9);
  });

  it("parses 'today at 09:30'", () => {
    const d = parseSchedule("today at 09:30", now);
    expect(d).not.toBeNull();
    expect(d?.getDate()).toBe(4);
    expect(d?.getHours()).toBe(9);
    expect(d?.getMinutes()).toBe(30);
  });

  it("rolls a past bare time to tomorrow", () => {
    const d = parseSchedule("at 5am", now);
    expect(d).not.toBeNull();
    expect(d?.getDate()).toBe(5);
    expect(d?.getHours()).toBe(5);
  });

  it("keeps a future bare time today", () => {
    const d = parseSchedule("at 5pm", now);
    expect(d).not.toBeNull();
    expect(d?.getDate()).toBe(4);
    expect(d?.getHours()).toBe(17);
  });

  it("returns null when no schedule can be derived", () => {
    expect(parseSchedule("in a while", now)).toBeNull();
    expect(parseSchedule("at 25pm", now)).toBeNull();
    expect(parseSchedule("at 13:70", now)).toBeNull();
  });
});
