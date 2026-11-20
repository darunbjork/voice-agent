import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { classifyByKeywords, isFeatureQuestion } from "../modules/agent/intent.classifier.js";
import { cleanLocation, extractWeatherLocation } from "../modules/agent/location.js";
import { weatherTool } from "../modules/agent/tools/weather.tool.js";
import {
  handleUtterance,
  formatConversation,
  MAX_CONVERSATION_SUMMARY_CHARS,
} from "../modules/agent/agent.service.js";
import { deepgramListenParams } from "../modules/audio/deepgram.proxy.js";
import { SYSTEM_PROMPT } from "../modules/agent/gemini.service.js";
import { env, envSchema } from "../env.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as unknown as FastifyBaseLogger;

describe("C. questions about a feature do not run it", () => {
  it.each([
    "What does reminder do in this application?",
    "What does the reminder feature do?",
    "How does the weather feature work?",
    "How does translation work?",
    "What is the summarize tool for?",
    "How do I use the reminder?",
    "Can you explain the translate feature in this app?",
  ])("%s → not a fast-path tool (Gemini answers as help/general)", (text) => {
    expect(isFeatureQuestion(text)).toBe(true);
    expect(classifyByKeywords(text)).toBeNull();
  });

  it.each([
    ["Remind me to call mum at 5", "reminder"],
    ["Set a reminder for the dentist tomorrow", "reminder"],
    ["Create a reminder to buy milk", "reminder"],
    ["Please remember to water the plants", "reminder"],
    ["Don't let me forget the meeting", "reminder"],
    ["What is the weather in Stockholm?", "weather"],
    ["Translate good morning to Swedish", "translate"],
    ["What does goodnight mean in Swedish?", "translate"],
  ])("%s → still runs %s", (text, intent) => {
    expect(classifyByKeywords(text)?.intent).toBe(intent);
  });

  it("the bare word 'reminder' is not an instruction", () => {
    expect(classifyByKeywords("I like the reminder")?.intent).not.toBe("reminder");
    expect(classifyByKeywords("Is the reminder thing any good?")?.intent).not.toBe("reminder");
  });

  it("the Gemini prompt tells the model to explain features as help, not perform them", () => {
    expect(SYSTEM_PROMPT).toMatch(/question ABOUT a feature/);
    expect(SYSTEM_PROMPT).toMatch(/"help": explain the feature, do not perform it/);
  });
});

describe("D. summarize the conversation", () => {
  beforeEach(() => resetUsageMemory());

  it.each([
    "Summarize everything we discussed",
    "Can you summarize what we talked about?",
    "Give me a summary of our conversation",
    "Recap this session",
    "Summarize what I asked so far",
  ])("%s → summarize with conversation scope", (text) => {
    expect(classifyByKeywords(text)).toMatchObject({
      intent: "summarize",
      slots: { scope: "conversation" },
    });
  });

  it("a plain 'summarize <text>' still summarizes the utterance", () => {
    expect(classifyByKeywords("Summarize: the cat sat on the mat")?.slots.scope).toBeUndefined();
  });

  it("summarizes the session history, not the request", async () => {
    const loadHistory = vi.fn(async () => [
      { role: "user" as const, text: "What does RAG stand for?" },
      { role: "agent" as const, text: "Retrieval-augmented generation." },
      { role: "user" as const, text: "What's MCP?" },
      { role: "agent" as const, text: "Model Context Protocol." },
    ]);
    const { reply } = await handleUtterance(
      {
        text: "Summarize everything we discussed",
        sessionId: "s",
        turnIndex: 2,
        sttLatencyMs: 0,
        loadHistory,
      },
      silent,
    );

    expect(loadHistory).toHaveBeenCalledOnce();
    expect(reply.intent).toBe("summarize");
    expect(reply.card).toMatchObject({ type: "summary", source: "this conversation" });
    const points = (reply.card as { points: string[] }).points.join(" ");
    expect(points).toContain("What does RAG stand for?");
    expect(points).toContain("What's MCP?");
    expect(points).not.toContain("Summarize everything");
    expect(reply.text).toMatch(/our conversation/);
  });

  it("says so when nothing has been discussed yet", async () => {
    const { reply } = await handleUtterance(
      {
        text: "Summarize everything we discussed",
        sessionId: "s",
        turnIndex: 0,
        sttLatencyMs: 0,
        loadHistory: async () => [],
      },
      silent,
    );
    expect(reply.text).toMatch(/not discussed anything yet/);
    expect(reply.card).toBeNull();
  });

  it("falls back to the recent context if history cannot be loaded", async () => {
    const { reply } = await handleUtterance(
      {
        text: "Summarize our conversation",
        sessionId: "s",
        turnIndex: 1,
        sttLatencyMs: 0,
        context: [{ role: "user", text: "How are you?" }],
        loadHistory: async () => {
          throw new Error("db down");
        },
      },
      silent,
    );
    expect((reply.card as { points: string[] }).points.join(" ")).toContain("How are you?");
  });

  it("keeps the newest part of a long conversation", () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({
      role: "user" as const,
      text: `question number ${i}`,
    }));
    const text = formatConversation(turns);
    expect(text.length).toBeLessThanOrEqual(MAX_CONVERSATION_SUMMARY_CHARS);
    expect(text).toContain("question number 199");
    expect(text).not.toContain("question number 0\n");
  });
});

describe("E. weather locations", () => {
  it.each([
    ["Sweden right now", "Sweden"],
    ["Stockholm today", "Stockholm"],
    ["Paris please", "Paris"],
    ["the city of Rome at the moment", "Rome"],
    ["New York City tonight?", "New York City"],
  ])("cleanLocation(%s) → %s", (raw, want) => {
    expect(cleanLocation(raw)).toBe(want);
  });

  it.each([
    ["What's the weather in Sweden right now?", "Sweden"],
    ["What is the weather in Stockholm today?", "Stockholm"],
    ["How cold is it in Gothenburg right now", "Gothenburg"],
    ["Weather tomorrow in New York City", "New York City"],
    ["What's the weather like in Oslo at the moment?", "Oslo"],
  ])("%s → location %s", (text, want) => {
    expect(extractWeatherLocation(text)).toBe(want);
    expect(classifyByKeywords(text)?.slots.location).toBe(want);
  });

  describe("country without a city", () => {
    const queries: string[] = [];

    beforeEach(() => {
      queries.length = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(String(input));
          const json = (body: unknown) =>
            new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
          if (url.host === "geocoding-api.open-meteo.com") {
            const name = url.searchParams.get("name") ?? "";
            queries.push(
              name +
                (url.searchParams.get("countryCode")
                  ? `@${url.searchParams.get("countryCode")}`
                  : ""),
            );
            const places: Record<string, unknown> = {
              Sweden: {
                name: "Sweden",
                country: "Sweden",
                country_code: "SE",
                feature_code: "PCLI",
                latitude: 62,
                longitude: 15,
              },
              Stockholm: {
                name: "Stockholm",
                country: "Sweden",
                country_code: "SE",
                feature_code: "PPLC",
                latitude: 59.33,
                longitude: 18.07,
              },
              Tuvalu: {
                name: "Tuvalu",
                country: "Tuvalu",
                country_code: "TV",
                feature_code: "PCLI",
                latitude: -8,
                longitude: 178,
              },
            };
            return json({ results: places[name] ? [places[name]] : [] });
          }
          return json({
            current: {
              temperature_2m: 4,
              relative_humidity_2m: 80,
              wind_speed_10m: 10,
              weather_code: 3,
            },
          });
        }),
      );
    });

    afterEach(() => vi.unstubAllGlobals());

    it("uses the capital and says so", async () => {
      const r = await weatherTool({
        userText: "What's the weather in Sweden right now?",
        slots: {},
      });
      expect(queries).toEqual(["Sweden", "Stockholm@SE"]);
      expect(r.card?.location).toBe("Stockholm, Sweden");
      expect(r.replyHint).toBe(
        "For Sweden I am using the capital, Stockholm. It is 4°C and overcast in Stockholm, Sweden.",
      );
    });

    it("strips time words from a slot too", async () => {
      const r = await weatherTool({ userText: "", slots: { location: "Sweden right" } });
      expect(r.card?.location).toBe("Stockholm, Sweden");
    });

    it("asks which city when the capital is unknown", async () => {
      const r = await weatherTool({ userText: "weather in Tuvalu", slots: {} });
      expect(r.card).toBeNull();
      expect(r.replyHint).toBe(
        "Tuvalu is a big place. Which city in Tuvalu would you like the weather for?",
      );
    });

    it("a city is used directly", async () => {
      const r = await weatherTool({ userText: "weather in Stockholm today", slots: {} });
      expect(queries).toEqual(["Stockholm"]);
      expect(r.replyHint).toBe("It is 4°C and overcast in Stockholm, Sweden.");
    });
  });
});

describe("F. Deepgram model and tech vocabulary", () => {
  const saved = { model: env.DEEPGRAM_MODEL, terms: env.DEEPGRAM_KEYTERMS };
  afterEach(() => {
    env.DEEPGRAM_MODEL = saved.model;
    env.DEEPGRAM_KEYTERMS = saved.terms;
  });

  it("defaults to nova-3 with the tech keyterms", () => {
    const parsed = envSchema.parse({ DATABASE_URL: "postgresql://x", JWT_SECRET: "x".repeat(32) });
    expect(parsed.DEEPGRAM_MODEL).toBe("nova-3");
    expect(parsed.DEEPGRAM_KEYTERMS).toEqual([
      "RAG",
      "MCP",
      "agentic",
      "LLM",
      "API",
      "Gemini",
      "Deepgram",
      "ElevenLabs",
    ]);
  });

  it("parses a custom comma-separated keyterm list", () => {
    const parsed = envSchema.parse({
      DATABASE_URL: "postgresql://x",
      JWT_SECRET: "x".repeat(32),
      DEEPGRAM_KEYTERMS: " RAG , vector database,,",
    });
    expect(parsed.DEEPGRAM_KEYTERMS).toEqual(["RAG", "vector database"]);
  });

  it("nova-3 sends one keyterm param per term", () => {
    env.DEEPGRAM_MODEL = "nova-3";
    env.DEEPGRAM_KEYTERMS = ["RAG", "MCP", "agentic"];
    const p = deepgramListenParams();
    expect(p.get("model")).toBe("nova-3");
    expect(p.getAll("keyterm")).toEqual(["RAG", "MCP", "agentic"]);
    expect(p.getAll("keywords")).toEqual([]);
    expect(p.get("utterance_end_ms")).toBe("1000");
  });

  it("nova-2 (no keyterm support) gets boosted keywords instead", () => {
    env.DEEPGRAM_MODEL = "nova-2";
    env.DEEPGRAM_KEYTERMS = ["RAG", "MCP"];
    const p = deepgramListenParams();
    expect(p.getAll("keyterm")).toEqual([]);
    expect(p.getAll("keywords")).toEqual(["RAG:2", "MCP:2"]);
  });
});
