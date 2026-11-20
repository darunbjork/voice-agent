import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import {
  parseTranslateRequest,
  parseLanguageAnswer,
  parseMeaningWithoutLanguage,
  normaliseTranscript,
} from "../modules/agent/translate-request.js";
import {
  extractTranslateRequest,
  TRANSLATE_EXTRACT_JSON_SCHEMA,
} from "../modules/agent/translate-extract.js";
import { translateTool } from "../modules/agent/tools/translate.tool.js";
import { handleUtterance, completePendingTranslation } from "../modules/agent/agent.service.js";
import { resetPendingRequests, PENDING_TTL_MS } from "../modules/agent/pending-requests.js";
import { classifyByKeywords } from "../modules/agent/intent.classifier.js";
import {
  parseForecastDay,
  regionName,
  splitCountry,
  extractWeatherLocation,
} from "../modules/agent/location.js";
import { weatherTool } from "../modules/agent/tools/weather.tool.js";
import { SYSTEM_PROMPT, AGENT_TEMPERATURE } from "../modules/agent/gemini.service.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";

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

const say = (text: string, sessionId = "s1", turnIndex = 0) =>
  handleUtterance({ text, sessionId, turnIndex, sttLatencyMs: 0 }, silent).then((r) => r.reply);

beforeEach(() => {
  resetPendingRequests();
  resetUsageMemory();
  resetAllCircuits();
});

// ── 1. Translation ─────────────────────────────────────────────────────────

describe("1. translation: STT punctuation and from X to Y", () => {
  it("strips speech-recognition punctuation", () => {
    expect(normaliseTranscript("What does, lunch mean in Danish?")).toBe(
      "What does lunch mean in Danish?",
    );
  });

  it('"What does, lunch mean in Danish?" → lunch / Danish → frokost', async () => {
    expect(parseTranslateRequest("What does, lunch mean in Danish?")).toMatchObject({
      original: "lunch",
      language: { name: "danish", code: "da" },
    });
    const reply = await say("What does, lunch mean in Danish?");
    expect(reply.intent).toBe("translate");
    expect(reply.text).toBe("lunch in Danish is frokost.");
  });

  it('"Translate lunch from English to Danish" → frokost, source English', async () => {
    expect(parseTranslateRequest("Translate lunch from English to Danish")).toEqual({
      original: "lunch",
      source: { name: "english", code: "en" },
      language: { name: "danish", code: "da" },
    });
    const r = await translateTool({
      userText: "Translate lunch from English to Danish",
      slots: {},
    });
    expect(r.card).toMatchObject({
      original: "lunch",
      translated: "frokost",
      fromLang: "en",
      toLang: "da",
    });
  });

  it("also handles 'X from A to B' without the word translate, and STT commas", () => {
    expect(parseTranslateRequest("Good night, from English, to French")).toMatchObject({
      original: "Good night",
      language: { code: "fr" },
      source: { code: "en" },
    });
  });
});

describe("1. translation: pending request completed by the next turn", () => {
  it('"What does good night mean" → asks the language → "French" → bonne nuit', async () => {
    const ask = await say("What does good night mean", "s-gn", 0);
    expect(ask.intent).toBe("translate");
    expect(ask.card).toBeNull();
    expect(ask.text).toMatch(/^Which language should I translate "good night" into\?/);

    const done = await say("French", "s-gn", 1);
    expect(done.intent).toBe("translate");
    expect(done.text).toBe("good night in French is bonne nuit.");
    expect(done.card).toMatchObject({ original: "good night", translated: "bonne nuit" });
  });

  it.each(["French.", "In French, please", "into french", "french please"])(
    "the language answer may be phrased %s",
    async (answer) => {
      await say("Translate good night", "s-ans", 0);
      expect((await say(answer, "s-ans", 1)).text).toBe("good night in French is bonne nuit.");
    },
  );

  it("asking for the phrase works the other way round", async () => {
    expect((await say("Translate to Danish", "s-ph", 0)).text).toBe(
      "What would you like me to translate into Danish?",
    );
    expect((await say("lunch", "s-ph", 1)).text).toBe("lunch in Danish is frokost.");
  });

  it("the pending request is per session", async () => {
    await say("What does good night mean", "s-a", 0);
    const other = await say("French", "s-b", 0);
    expect(other.text).not.toContain("bonne nuit");
  });

  it("a different request drops the pending translation", async () => {
    await say("What does good night mean", "s-drop", 0);
    expect((await say("What's the weather in Oslo?", "s-drop", 1)).intent).toBe("weather");
    // …and it is gone afterwards.
    expect((await say("French", "s-drop", 2)).text).not.toContain("bonne nuit");
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await say("What does good night mean", "s-ttl", 0);
      vi.setSystemTime(Date.now() + PENDING_TTL_MS + 1);
      expect((await say("French", "s-ttl", 1)).text).not.toContain("bonne nuit");
    } finally {
      vi.useRealTimers();
    }
  });

  it('"meaning" instead of a language asks for the definition', () => {
    expect(completePendingTranslation({ original: "good night" }, "the meaning", null)).toEqual({
      kind: "meaning",
      text: 'What does "good night" mean?',
    });
  });

  it("parseLanguageAnswer accepts only a bare language", () => {
    expect(parseLanguageAnswer("French")?.code).toBe("fr");
    expect(parseLanguageAnswer("In Danish please.")?.code).toBe("da");
    expect(parseLanguageAnswer("What's the weather?")).toBeNull();
    expect(parseLanguageAnswer("French and Spanish")).toBeNull();
  });

  it("single words and acronyms stay definition questions", async () => {
    expect(parseMeaningWithoutLanguage("What does RAG mean?")).toBeNull();
    expect(parseMeaningWithoutLanguage("What does n8n mean?")).toBeNull();
    expect((await say("What does endemic mean?", "s-def", 0)).intent).not.toBe("translate");
  });
});

describe("1. translation: LLM structured extraction (live, mocked Gemini)", () => {
  const saved = { mock: env.VOICE_MOCK, key: env.GEMINI_API_KEY };
  beforeEach(() => {
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "k";
    generateContentMock.mockReset();
  });
  afterEach(() => {
    env.VOICE_MOCK = saved.mock;
    env.GEMINI_API_KEY = saved.key;
  });

  it("extracts phrase/source/target with a JSON schema at temperature 0, then translates", async () => {
    generateContentMock
      .mockResolvedValueOnce({
        text: JSON.stringify({ phrase: "lunch", sourceLang: "English", targetLang: "Danish" }),
      })
      .mockResolvedValueOnce({ text: "frokost" });

    const r = await translateTool({
      userText: "Okay, translate, lunch, from English, to Danish",
      slots: {},
    });

    const extractCall = generateContentMock.mock.calls[0]?.[0] as {
      contents: string;
      config: { responseJsonSchema: unknown; temperature: number };
    };
    expect(extractCall.contents).toBe("Okay translate lunch from English to Danish");
    expect(extractCall.config.responseJsonSchema).toBe(TRANSLATE_EXTRACT_JSON_SCHEMA);
    expect(extractCall.config.temperature).toBe(0);
    const translateCall = generateContentMock.mock.calls[1]?.[0] as { contents: string };
    expect(translateCall.contents).toBe("Translate from English to Danish:\nlunch");
    expect(r.card).toMatchObject({
      original: "lunch",
      translated: "frokost",
      fromLang: "en",
      toLang: "da",
    });
  });

  it("an LLM that finds no target language leads to a question, never a guess", async () => {
    generateContentMock.mockResolvedValueOnce({
      text: JSON.stringify({ phrase: "good night", sourceLang: null, targetLang: null }),
    });
    const r = await translateTool({ userText: "Can you translate good night", slots: {} });
    expect(r.card).toBeNull();
    expect(r.pending).toEqual({ original: "good night" });
  });

  it("falls back to the pattern parser when the LLM fails", async () => {
    generateContentMock.mockRejectedValue(
      Object.assign(new Error('{"error":{"code":503}}'), { status: 503 }),
    );
    expect(await extractTranslateRequest("What does, lunch mean in Danish?")).toMatchObject({
      original: "lunch",
      language: { code: "da" },
    });
  });
});

// ── 2. Weather ─────────────────────────────────────────────────────────────

describe("2. weather: forecast days", () => {
  const WEDNESDAY = 3;
  it.each([
    ["What's the weather tomorrow in Stockholm?", { kind: "day", offset: 1, label: "tomorrow" }],
    ["weather the day after tomorrow", { kind: "day", offset: 2, label: "the day after tomorrow" }],
    ["weather in Paris on Friday", { kind: "day", offset: 2, label: "on Friday" }],
    ["weather on Wednesday", { kind: "current" }],
    ["weather this weekend in Oslo", { kind: "day", offset: 3, label: "on Saturday" }],
    ["weather in 3 days", { kind: "day", offset: 3, label: "in 3 days" }],
    ["weather today", { kind: "current" }],
    ["weather in 10 days", { kind: "unsupported", phrase: "in 10 days" }],
    ["weather next month", { kind: "unsupported", phrase: "next month" }],
  ])("%s", (text, want) => {
    expect(parseForecastDay(text, WEDNESDAY)).toEqual(want);
  });

  it("time words never leak into the place name", () => {
    expect(extractWeatherLocation("What's the weather tomorrow in Stockholm?")).toBe("Stockholm");
    expect(extractWeatherLocation("weather in Paris on Friday")).toBe("Paris");
    expect(extractWeatherLocation("weather in Oslo the day after tomorrow")).toBe("Oslo");
  });

  it("tomorrow uses the daily forecast", async () => {
    const r = await weatherTool({
      userText: "What's the weather tomorrow in Stockholm?",
      slots: {},
    });
    // setup.ts: day 1 → min 3, max 11, rain code 61, 41 % precipitation.
    expect(r.replyHint).toBe("Tomorrow in Stockholm: rain, 3 to 11°C, 41% chance of rain.");
    expect(r.card).toMatchObject({ temp: "3 to 11°C", desc: "Rain (tomorrow)", humidity: "80%" });
  });

  it("beyond the 7-day forecast it says what is available", async () => {
    const r = await weatherTool({ userText: "weather in Oslo next month", slots: {} });
    expect(r.card).toBeNull();
    expect(r.replyHint).toBe(
      "I can only give the current weather or a forecast for the next 7 days, not next month. Which day would you like?",
    );
  });
});

describe("2. weather: regions and wrong-country matches", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let geocodeAnswer: (name: string, countryCode: string | null) => unknown[];
  beforeEach(() => {
    geocodeAnswer = () => [];
    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const body =
        url.host === "geocoding-api.open-meteo.com"
          ? {
              results: geocodeAnswer(
                url.searchParams.get("name") ?? "",
                url.searchParams.get("countryCode"),
              ),
            }
          : {
              current: {
                temperature_2m: 20,
                relative_humidity_2m: 50,
                wind_speed_10m: 5,
                weather_code: 0,
              },
            };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [
      "What's the weather in the Middle East?",
      "The Middle East is a big area. Which city in the Middle East would you like the weather for?",
    ],
    [
      "weather in Scandinavia",
      "Scandinavia is a big area. Which city in Scandinavia would you like the weather for?",
    ],
    [
      "How hot is it in Europe today?",
      "Europe is a big area. Which city in Europe would you like the weather for?",
    ],
  ])("%s → asks for a city without geocoding", async (text, reply) => {
    const r = await weatherTool({ userText: text, slots: {} });
    expect(r.card).toBeNull();
    expect(r.replyHint).toBe(reply);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a geocoder continent/region match also asks for a city", async () => {
    geocodeAnswer = () => [
      { name: "Atlantis Region", feature_code: "RGN", latitude: 0, longitude: 0 },
    ];
    const r = await weatherTool({ userText: "weather in Atlantis Region", slots: {} });
    expect(r.card).toBeNull();
    expect(r.replyHint).toMatch(/is a big area\. Which city there/);
  });

  it("a named country is enforced: the geocoder is filtered and a mismatch is rejected", async () => {
    // A geocoder that ignores countryCode and still returns Paris, France.
    geocodeAnswer = () => [
      {
        name: "Paris",
        country: "France",
        country_code: "FR",
        feature_code: "PPLC",
        latitude: 48.85,
        longitude: 2.35,
      },
    ];
    const r = await weatherTool({ userText: "What's the weather in Paris, Sweden?", slots: {} });
    const geoUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(geoUrl.searchParams.get("name")).toBe("Paris");
    expect(geoUrl.searchParams.get("countryCode")).toBe("SE");
    expect(r.card).toBeNull();
    expect(r.replyHint).toBe("I could not find Paris in that country. Which city did you mean?");
  });

  it("a matching country passes", async () => {
    geocodeAnswer = (_name, cc) =>
      cc === "FR"
        ? [
            {
              name: "Paris",
              country: "France",
              country_code: "FR",
              feature_code: "PPLC",
              latitude: 48.85,
              longitude: 2.35,
            },
          ]
        : [];
    const r = await weatherTool({ userText: "weather in Paris, France", slots: {} });
    expect(r.replyHint).toBe("It is 20°C and clear sky in Paris, France.");
  });

  it("splitCountry and regionName", () => {
    expect(splitCountry("Paris France")).toEqual({ place: "Paris", countryCode: "FR" });
    expect(splitCountry("Springfield USA")).toEqual({ place: "Springfield", countryCode: "US" });
    expect(splitCountry("New York City")).toEqual({ place: "New York City" });
    expect(splitCountry("Sweden")).toEqual({ place: "Sweden" });
    expect(regionName("middle east")).toBe("the Middle East");
    expect(regionName("Stockholm")).toBeNull();
  });

  it("the classifier still routes weather questions with days", () => {
    expect(classifyByKeywords("What's the weather tomorrow in Stockholm?")).toMatchObject({
      intent: "weather",
      slots: { location: "Stockholm" },
    });
  });
});

// ── 3. General answers ─────────────────────────────────────────────────────

describe("3. general answers", () => {
  it("temperature is at most 0.3", () => {
    expect(AGENT_TEMPERATURE).toBeLessThanOrEqual(0.3);
  });

  it("no scientific names or exact figures unless certain; prefer I'm not sure", () => {
    expect(SYSTEM_PROMPT).toMatch(
      /No scientific \(Latin\) names, exact figures, dates, statistics, measurements or quotes unless you are certain/,
    );
    expect(SYSTEM_PROMPT).toMatch(/Prefer "I'm not sure" over a precise-sounding guess/);
  });
});
