// Live bug: "What is the weather in France?" was answered as a translation
// ("the weather in French is le temps"). The fuzzy language matcher accepted
// "France" (2 edits from "french") and "Germany" (1 edit from "german"); "UK"
// matched the ISO code for Ukrainian. A country or region is a place, never a
// target language.
import { describe, it, expect } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { classifyByKeywords } from "../modules/agent/intent.classifier.js";
import { resolveLanguage } from "../modules/agent/translate-request.js";
import { handleUtterance } from "../modules/agent/agent.service.js";

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as unknown as FastifyBaseLogger;

describe("weather + a country or region routes to weather", () => {
  it.each([
    ["What is the weather in France?", "France"],
    ["What's the weather in Germany?", "Germany"],
    ["weather in Norway", "Norway"],
    ["How is the weather in the UK?", "the UK"],
    ["What's the weather in Middle East?", "Middle East"],
  ])('"%s" → weather', (text, location) => {
    const r = classifyByKeywords(text);
    expect(r?.intent).toBe("weather");
    expect(r?.slots.location?.toLowerCase()).toContain(location.replace(/^the /, "").toLowerCase());
  });

  it("the full turn answers with weather, not a translation", async () => {
    const { reply } = await handleUtterance(
      { text: "What is the weather in France?", sessionId: "b7", turnIndex: 0, sttLatencyMs: 0 },
      silent,
    );
    expect(reply.intent).toBe("weather");
    expect(reply.card?.type).not.toBe("translate");
    expect(reply.text.toLowerCase()).not.toContain("in french");
  });
});

describe("real translation requests still translate", () => {
  it.each([
    ["Translate weather to French", "weather", "french"],
    ["What does weather mean in German?", "weather", "german"],
    ["Translate good night to Norwegian", "good night", "norwegian"],
  ])('"%s" → translate', (text, original, toLang) => {
    const r = classifyByKeywords(text);
    expect(r).toMatchObject({ intent: "translate", slots: { original, toLang } });
  });
});

describe("resolveLanguage never returns a language for a place", () => {
  it.each(["France", "Germany", "Sweden", "UK", "Norway", "Europe", "Scandinavia"])(
    "%s is not a language",
    (word) => {
      expect(resolveLanguage(word)).toBeNull();
    },
  );

  it("misheard language names still resolve", () => {
    expect(resolveLanguage("Frensh")?.name).toBe("french");
    expect(resolveLanguage("Swedish")?.name).toBe("swedish");
    expect(resolveLanguage("uk")).toBeNull();
    expect(resolveLanguage("ukrainian")?.name).toBe("ukrainian");
  });
});
