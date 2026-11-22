// Weather, translation and reminder data come only from the tools. The model
// may pick the tool (and name the city / phrase / task), never write the data.
// Live bug: after "Which city?", "Paris" / "London" / "York" went to the LLM,
// which answered with an invented card (wind 15 km/h for every city, no icon).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { resetPendingRequests } from "../modules/agent/pending-requests.js";
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

const say = (text: string, sessionId = "grounding") =>
  handleUtterance({ text, sessionId, turnIndex: 0, sttLatencyMs: 0 }, silent).then((r) => r.reply);

/** The model's structured reply (JSON) or a tool's plain-text completion. */
function llmAnswers(agentJson: object, toolText = "Bonne nuit") {
  generateContentMock.mockImplementation(
    async (req: { config?: { responseMimeType?: string } }) => ({
      text:
        req.config?.responseMimeType === "application/json" ? JSON.stringify(agentJson) : toolText,
      candidates: [{ finishReason: "STOP" }],
    }),
  );
}

/** A card the model made up — every value here must never reach the user. */
const inventedWeather = (location: string) => ({
  reply: `It is 9°C in ${location} with wind at 15 km/h.`,
  intent: "weather",
  card: {
    type: "weather",
    icon: "",
    temp: "9°C",
    desc: "cloudy",
    humidity: "80%",
    wind: "15 km/h",
    location,
  },
});

const original = {
  mock: env.VOICE_MOCK,
  key: env.GEMINI_API_KEY,
  fallback: env.GEMINI_FALLBACK_MODEL,
};

/** Open-Meteo place names requested so far (setup.ts answers them locally). */
const geocoded: string[] = [];
let realFetch: typeof fetch;

beforeEach(() => {
  env.VOICE_MOCK = false;
  env.GEMINI_API_KEY = "test-key";
  env.GEMINI_FALLBACK_MODEL = "";
  generateContentMock.mockReset();
  resetPendingRequests();
  resetUsageMemory();
  resetAllCircuits();
  geocoded.length = 0;
  realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("geocoding-api.open-meteo.com")) {
      geocoded.push(new URL(url).searchParams.get("name") ?? "");
    }
    return realFetch(input, init);
  });
});

afterEach(() => {
  env.VOICE_MOCK = original.mock;
  env.GEMINI_API_KEY = original.key;
  env.GEMINI_FALLBACK_MODEL = original.fallback;
  vi.unstubAllGlobals();
});

describe("weather data comes only from the weather tool", () => {
  it('"Which city?" → "Paris" calls the weather API, not the LLM', async () => {
    const ask = await say("What's the weather in the Middle East?");
    expect(ask.card).toBeNull();
    expect(ask.text).toMatch(/which city/i);

    const answer = await say("Paris");
    expect(generateContentMock).not.toHaveBeenCalled();
    expect(geocoded).toEqual(["Paris"]);
    expect(answer.intent).toBe("weather");
    expect(answer.card).toMatchObject({ type: "weather", location: "Paris", wind: "14 km/h" });
  });

  it.each(["London", "York", "New York", "in Paris please"])(
    'a follow-up "%s" after "Which city?" is answered by the tool',
    async (city) => {
      await say("What's the weather in Europe?");
      const answer = await say(city);
      expect(generateContentMock).not.toHaveBeenCalled();
      expect(answer.card?.type).toBe("weather");
      expect(answer.card).not.toMatchObject({ wind: "15 km/h" });
    },
  );

  it("an LLM-chosen weather turn uses the model's city but the tool's numbers", async () => {
    llmAnswers(inventedWeather("London"));
    const reply = await say("And how about London then?");
    expect(geocoded).toEqual(["London"]);
    expect(reply.card).toMatchObject({ type: "weather", location: "London", wind: "14 km/h" });
    expect(reply.text).not.toContain("15 km/h");
    expect(reply.text).not.toContain("9°C");
  });

  it("an LLM weather turn without a city asks for one, and the answer goes to the tool", async () => {
    llmAnswers({ reply: "It is mild and sunny.", intent: "weather", card: null });
    const ask = await say("What is it like outside?");
    expect(ask.card).toBeNull();
    expect(ask.text).toMatch(/which city/i);
    expect(ask.text).not.toContain("sunny");

    generateContentMock.mockClear();
    const answer = await say("York");
    expect(generateContentMock).not.toHaveBeenCalled();
    expect(geocoded).toEqual(["York"]);
    expect(answer.card?.type).toBe("weather");
  });

  it("when the weather service is down there is no card and no numbers", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const reply = await say("What's the weather in Oslo?");
    expect(reply.card).toBeNull();
    expect(reply.text).toMatch(/could not reach the weather service/i);
    expect(reply.text).not.toMatch(/\d/);
  });

  it('"never mind" clears a pending weather question', async () => {
    await say("What's the weather in Asia?");
    llmAnswers({ reply: "Okay.", intent: "general", card: null });
    const reply = await say("never mind");
    expect(geocoded).toEqual([]);
    expect(reply.card).toBeNull();
  });

  it("a real question after a pending weather question is not treated as a city", async () => {
    await say("What's the weather in Africa?");
    llmAnswers({
      reply: "RAG means retrieval-augmented generation.",
      intent: "general",
      card: null,
    });
    const reply = await say("What is RAG?");
    expect(generateContentMock).toHaveBeenCalled();
    expect(geocoded).toEqual([]);
    expect(reply.text).toContain("retrieval-augmented");
  });
});

describe("translation and reminder data come only from their tools", () => {
  it("an LLM-chosen translation is translated by the tool, not taken from the model's card", async () => {
    llmAnswers(
      {
        reply: "In French that is bonne nuit FAKE.",
        intent: "translate",
        card: {
          type: "translate",
          original: "good night",
          translated: "bonne nuit FAKE",
          fromLang: "English",
          toLang: "French",
        },
      },
      "Bonne nuit",
    );
    const reply = await say("How would a French person put good night");
    expect(reply.card).toMatchObject({ type: "translate", original: "good night" });
    expect(JSON.stringify(reply)).not.toContain("FAKE");
  });

  it("an LLM-chosen reminder goes through the reminder tool, not the model's confirmation", async () => {
    // Live mode: the reminder tool writes to the local test database.
    const llmClaim = "Done! I set an alarm on your phone for 5 pm.";
    llmAnswers({
      reply: llmClaim,
      intent: "reminder",
      card: { type: "reminder", note: "call mom", time: "at 5 pm" },
    });
    const reply = await say("Jot down that I call mom at 5 pm");
    expect(reply.text).not.toBe(llmClaim);
    expect(reply.card).toMatchObject({ type: "reminder" });
  });
});
