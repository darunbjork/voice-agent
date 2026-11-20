import { describe, it, expect } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import {
  parseTranslateRequest,
  resolveLanguage,
  cleanPhrase,
  TRANSLATE_CLARIFY_REPLY,
} from "../modules/agent/translate-request.js";
import { classifyByKeywords } from "../modules/agent/intent.classifier.js";
import { translateTool } from "../modules/agent/tools/translate.tool.js";
import { handleUtterance } from "../modules/agent/agent.service.js";

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as unknown as FastifyBaseLogger;

/** [utterance, phrase, language name] */
const PHRASINGS: Array<[string, string, string]> = [
  // translate X to / into / in Y
  ["Translate good morning to Swedish", "good morning", "swedish"],
  ["Translate good morning into Swedish", "good morning", "swedish"],
  ["Translate hello world in Swedish", "hello world", "swedish"],
  ["translate thank you very much to Spanish please", "thank you very much", "spanish"],
  ['Translate "see you later" into French.', "see you later", "french"],
  ["Translate to German: good night", "good night", "german"],
  ["Okay. Translation. Translate go away to Swedish", "go away", "swedish"],
  // how do you say X in Y
  ["How do you say good morning in Swedish?", "good morning", "swedish"],
  ["How would I say where is the station in Italian", "where is the station", "italian"],
  // what does X mean in Y
  ["What does goodnight mean in Swedish?", "goodnight", "swedish"],
  ["Okay. Translation. What does go away mean in Swedish", "go away", "swedish"],
  ["What does the word high mean in Swedish?", "high", "swedish"],
  ["What dose sleep mean in Sweidhs?", "sleep", "swedish"],
  // what is X in Y
  ["What is good morning in Swedish?", "good morning", "swedish"],
  ["What's thank you in Japanese?", "thank you", "japanese"],
  ["What is the meaning of well-done in German?", "well-done", "german"],
  ["What's the Swedish word for butterfly?", "butterfly", "swedish"],
  // X in Y please
  ["Good morning in Swedish please", "Good morning", "swedish"],
  ["good evening in Norwegian, please.", "good evening", "norwegian"],
  ["Happy birthday in Spanish", "Happy birthday", "spanish"],
  // say X in Y
  ["Say good luck in Finnish", "good luck", "finnish"],
];

describe("parseTranslateRequest — every phrasing, multi-word phrases", () => {
  it.each(PHRASINGS)("%s → %s / %s", (utterance, phrase, language) => {
    const r = parseTranslateRequest(utterance);
    expect(r.original).toBe(phrase);
    expect(r.language?.name).toBe(language);
  });

  it.each(PHRASINGS)(
    "classifier routes %s to translate with both slots",
    (utterance, phrase, language) => {
      expect(classifyByKeywords(utterance)).toMatchObject({
        intent: "translate",
        slots: { original: phrase, toLang: language },
      });
    },
  );
});

describe("the live bug: Translate good morning to Swedish", () => {
  it("translates good morning, not hello → god morgon", async () => {
    const r = await translateTool({
      userText: "Translate good morning to Swedish",
      slots: classifyByKeywords("Translate good morning to Swedish")!.slots,
    });
    expect(r.card).toMatchObject({
      type: "translate",
      original: "good morning",
      translated: "god morgon",
      toLang: "sv",
    });
    expect(r.replyHint).toBe("good morning in Swedish is god morgon.");
  });

  it("end to end through handleUtterance (3/3, as in the live test)", async () => {
    for (let i = 0; i < 3; i++) {
      const { reply } = await handleUtterance(
        {
          text: "Translate good morning to Swedish",
          sessionId: "s",
          turnIndex: i,
          sttLatencyMs: 0,
        },
        silent,
      );
      expect(reply.intent).toBe("translate");
      expect(reply.text).toBe("good morning in Swedish is god morgon.");
      expect(reply.text.toLowerCase()).not.toContain("hej");
    }
  });

  it("the tool parses the utterance itself when the classifier gave no slots", async () => {
    const r = await translateTool({ userText: "Translate good morning to Swedish", slots: {} });
    expect(r.card?.translated).toBe("god morgon");
  });
});

describe("never a default phrase or language — ask instead", () => {
  it.each([
    ["Translate", TRANSLATE_CLARIFY_REPLY],
    ["Translate please", TRANSLATE_CLARIFY_REPLY],
    ["Translate this", TRANSLATE_CLARIFY_REPLY],
    ["I need a translation", TRANSLATE_CLARIFY_REPLY],
    ["Translate to Swedish", "What would you like me to translate into Swedish?"],
    ["Can you translate into French?", "What would you like me to translate into French?"],
    ["Translate good morning", 'Which language should I translate "good morning" into?'],
    ["Translate good morning to Klingon", 'Which language should I translate "good morning" into?'],
  ])("%s → asks only for what is missing", async (utterance, question) => {
    const r = await translateTool({
      userText: utterance,
      slots: classifyByKeywords(utterance)?.slots ?? {},
    });
    expect(r.card).toBeNull();
    expect(r.replyHint).toBe(question);
    expect(r.replyHint).not.toMatch(/hello|hej/i);
  });

  it("the exact clarification wording", () => {
    expect(TRANSLATE_CLARIFY_REPLY).toBe(
      "What would you like me to translate, and into which language?",
    );
  });

  it("partial understanding is kept for the slots", () => {
    expect(parseTranslateRequest("Translate to Swedish")).toEqual({
      language: { name: "swedish", code: "sv" },
    });
    expect(parseTranslateRequest("Translate good morning")).toEqual({ original: "good morning" });
  });
});

describe("helpers", () => {
  it("resolveLanguage accepts names, codes and close misspellings, rejects the rest", () => {
    expect(resolveLanguage("Swedish")).toEqual({ name: "swedish", code: "sv" });
    expect(resolveLanguage("sv")).toEqual({ name: "swedish", code: "sv" });
    expect(resolveLanguage("Sweidhs")).toEqual({ name: "swedish", code: "sv" });
    expect(resolveLanguage("Spansih")?.code).toBe("es");
    expect(resolveLanguage("Klingon")).toBeNull();
    expect(resolveLanguage("Stockholm")).toBeNull();
    expect(resolveLanguage("it")).toEqual({ name: "italian", code: "it" });
    expect(resolveLanguage("me")).toBeNull();
  });

  it("cleanPhrase strips quotes, lead-ins, 'please' and placeholders", () => {
    expect(cleanPhrase('"good morning"')).toBe("good morning");
    expect(cleanPhrase("the phrase good night, please")).toBe("good night");
    expect(cleanPhrase("Okay. Translation. go away")).toBe("go away");
    expect(cleanPhrase("this")).toBe("");
  });

  it("does not mistake other requests for translations", () => {
    expect(classifyByKeywords("What is the weather in Stockholm?")?.intent).toBe("weather");
    expect(classifyByKeywords("Remind me to call mum in Spanish class")?.intent).toBe("reminder");
    expect(classifyByKeywords("Summarize everything in French")?.intent).not.toBe("translate");
  });
});
