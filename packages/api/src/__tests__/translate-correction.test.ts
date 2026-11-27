// C9 — a self-correction inside one utterance ("Translate to French, sorry, I
// mean Spanish: good night") uses the LAST stated language, and the correction
// words are not part of the phrase. A quoted phrase that only looks like a
// correction ("no, I mean it") is still translated as it is.
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { parseTranslateRequest } from "../modules/agent/translate-request.js";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { resetPendingRequests } from "../modules/agent/pending-requests.js";

const log = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
} as unknown as FastifyBaseLogger;

const say = (text: string) =>
  handleUtterance({ text, sessionId: "c9", turnIndex: 0, sttLatencyMs: 0 }, log).then(
    (r) => r.reply,
  );

beforeEach(() => resetPendingRequests());

describe("self-correction inside one utterance", () => {
  it('"Translate to French, sorry, I mean Spanish: good night" → Spanish, "good night"', async () => {
    const parsed = parseTranslateRequest("Translate to French, sorry, I mean Spanish: good night");
    expect(parsed.language?.code).toBe("es");
    expect(parsed.original).toBe("good night");

    const reply = await say("Translate to French, sorry, I mean Spanish: good night");
    expect(reply.card).toMatchObject({ type: "translate", original: "good night", toLang: "es" });
  });

  it('"Translate the word den to French, no, I mean Spanish" → Spanish, "den"', async () => {
    const parsed = parseTranslateRequest("Translate the word den to French, no, I mean Spanish");
    expect(parsed.language?.code).toBe("es");
    expect(parsed.original).toBe("den");

    const reply = await say("Translate the word den to French, no, I mean Spanish");
    expect(reply.card).toMatchObject({ type: "translate", original: "den", toLang: "es" });
  });

  it.each([
    ["Translate hello to German, actually Swedish", "sv", "hello"],
    ["Translate goodbye into French... oops, I meant Spanish", "es", "goodbye"],
  ])('"%s" → last language', (text, code, phrase) => {
    const parsed = parseTranslateRequest(text);
    expect(parsed.language?.code).toBe(code);
    expect(parsed.original).toBe(phrase);
  });

  it(`"Translate 'no, I mean it' to French" is a real phrase, not a correction`, async () => {
    const parsed = parseTranslateRequest("Translate 'no, I mean it' to French");
    expect(parsed.language?.code).toBe("fr");
    expect(parsed.original).toMatch(/^no,? I mean it$/i);

    const reply = await say("Translate 'no, I mean it' to French");
    expect(reply.card).toMatchObject({ type: "translate", toLang: "fr" });
  });

  it("a plain request is unchanged", () => {
    const parsed = parseTranslateRequest("Translate good night to Spanish");
    expect(parsed).toMatchObject({ original: "good night", language: { code: "es" } });
  });
});
