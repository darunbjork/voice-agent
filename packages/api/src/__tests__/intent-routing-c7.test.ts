// C7 — live routing bugs:
// - "Thanks for the help" opened the HELP menu (keyword "help" anywhere).
// - "Which post-WWII program provided U.S. financial and technical aid …"
//   opened the HELP menu twice (the model labelled it "help").
// - "What are the synonyms in English for native and origin" became a
//   translation English → English.
// Help is only for an explicit request for help/commands; a translation never
// has the same source and target language; synonym questions go to the LLM.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { GeminiAgentOutput } from "@voice-agent/shared-types";

vi.mock("../modules/agent/gemini.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/agent/gemini.service.js")>();
  return { ...actual, safeGenerateAgentOutput: vi.fn(actual.safeGenerateAgentOutput) };
});

import { handleUtterance } from "../modules/agent/agent.service.js";
import { classifyByKeywords } from "../modules/agent/intent.classifier.js";
import { safeGenerateAgentOutput } from "../modules/agent/gemini.service.js";
import { resetPendingRequests } from "../modules/agent/pending-requests.js";

const log = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
} as unknown as FastifyBaseLogger;

const say = (text: string) =>
  handleUtterance({ text, sessionId: "c7", turnIndex: 0, sttLatencyMs: 0 }, log).then(
    (r) => r.reply,
  );

/** What a model returned live for a history question: intent help + help card. */
const modelSaysHelp: GeminiAgentOutput = {
  reply: "The Marshall Plan provided aid to rebuild Western Europe after World War II.",
  intent: "help",
  card: {
    type: "help",
    commands: [{ name: "weather", description: "Get the weather" }],
  },
};

beforeEach(() => {
  resetPendingRequests();
  vi.mocked(safeGenerateAgentOutput).mockClear();
});

describe("help only on an explicit request for help or commands", () => {
  it.each(["help", "what can you do?", "list commands", "Help me", "What commands are there?"])(
    '"%s" opens the help menu',
    async (text) => {
      const reply = await say(text);
      expect(reply.intent).toBe("help");
      expect(reply.card?.type).toBe("help");
    },
  );

  it('"Thanks for the help" is not a help request', async () => {
    expect(classifyByKeywords("Thanks for the help")?.intent).not.toBe("help");
    const reply = await say("Thanks for the help");
    expect(reply.card?.type).not.toBe("help");
    expect(reply.intent).not.toBe("help");
  });

  it.each([
    "How do I cook rice?",
    "Can you help me write a cover letter?",
    "I need help with SQL joins",
  ])('"%s" is a question, not the help menu', async (text) => {
    expect(classifyByKeywords(text)?.intent).not.toBe("help");
  });

  it("a history question about 'aid' never shows the help menu, even if the model says help", async () => {
    const text =
      "Which post-WWII program provided U.S. financial and technical aid to rebuild Western Europe?";
    expect(classifyByKeywords(text)).toBeNull();
    vi.mocked(safeGenerateAgentOutput).mockResolvedValueOnce(modelSaysHelp);

    const reply = await say(text);
    expect(safeGenerateAgentOutput).toHaveBeenCalledTimes(1);
    expect(reply.card).toBeNull();
    expect(reply.intent).not.toBe("help");
    expect(reply.text).toMatch(/Marshall Plan/);
  });

  it("a question about a feature may keep the model's help answer", async () => {
    // Feature questions go to the model, which answers them as "help".
    vi.mocked(safeGenerateAgentOutput).mockResolvedValueOnce(modelSaysHelp);
    const reply = await say("How does the weather feature work?");
    expect(safeGenerateAgentOutput).toHaveBeenCalledTimes(1);
    expect(reply.intent).toBe("help");
  });
});

describe("translate never has the same source and target language", () => {
  it("a synonym question goes to the LLM, not to translate EN→EN", async () => {
    const text = "What are the synonyms in English for native and origin";
    expect(classifyByKeywords(text)).toBeNull();
    const reply = await say(text);
    expect(safeGenerateAgentOutput).toHaveBeenCalledTimes(1);
    expect(reply.intent).not.toBe("translate");
    expect(reply.card?.type).not.toBe("translate");
  });

  it.each([
    "Give me another word for happy",
    "Rephrase this in English: I am very tired",
    "What is an antonym of ancient?",
  ])('"%s" goes to the LLM', async (text) => {
    expect(classifyByKeywords(text)?.intent).not.toBe("translate");
  });

  it('"Translate hello into English" is not answered as English → English', async () => {
    const reply = await say("Translate hello into English");
    expect(reply.card?.type).not.toBe("translate");
    expect(safeGenerateAgentOutput).toHaveBeenCalledTimes(1);
  });

  it('"Translate hello from English to English" goes to the LLM', async () => {
    const reply = await say("Translate hello from English to English");
    expect(reply.card?.type).not.toBe("translate");
  });

  it("a model-chosen translation with the same source and target is not run", async () => {
    vi.mocked(safeGenerateAgentOutput).mockResolvedValueOnce({
      reply: "Synonyms for native include indigenous and aboriginal.",
      intent: "translate",
      card: {
        type: "translate",
        original: "native",
        translated: "native",
        fromLang: "en",
        toLang: "en",
      },
    });
    const reply = await say("Tell me words close in meaning to native");
    expect(reply.card).toBeNull();
    expect(reply.intent).not.toBe("translate");
    expect(reply.text).toMatch(/indigenous/);
  });

  it("a real translation still works", async () => {
    const reply = await say("Translate hello into Spanish");
    expect(reply.card).toMatchObject({ type: "translate", fromLang: "en", toLang: "es" });
  });
});
