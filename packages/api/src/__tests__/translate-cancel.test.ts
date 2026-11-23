// A pending translation ("What would you like me to translate into French?")
// is cleared by "nothing" / "cancel" / "never mind", and a correction
// ("no, I meant Spanish") updates it. Live bug: the next utterance was taken
// as the phrase, so "nothing" and "cancel" were translated into French.
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { resetPendingRequests } from "../modules/agent/pending-requests.js";

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as unknown as FastifyBaseLogger;

const say = (text: string) =>
  handleUtterance({ text, sessionId: "tc", turnIndex: 0, sttLatencyMs: 0 }, silent).then(
    (r) => r.reply,
  );

beforeEach(() => {
  resetPendingRequests();
});

describe("cancelling a pending translation", () => {
  it.each(["nothing", "Nothing, thanks", "cancel", "never mind", "Forget it.", "no thanks", "no"])(
    'after "Translate to French", "%s" cancels instead of being translated',
    async (answer) => {
      const ask = await say("Translate to French");
      expect(ask.text).toMatch(/translate into French/i);

      const reply = await say(answer);
      expect(reply.card).toBeNull();
      expect(reply.text).toMatch(/no translation/i);

      // The pending question is gone: the next phrase is not silently translated.
      const next = await say("good night");
      expect(next.card?.type).not.toBe("translate");
    },
  );

  it('after "Which language?", "cancel" clears it', async () => {
    const ask = await say("Translate good night");
    expect(ask.text).toMatch(/which language/i);
    const reply = await say("cancel");
    expect(reply.card).toBeNull();
    expect(reply.text).toMatch(/no translation/i);
    const next = await say("French");
    expect(next.card?.type).not.toBe("translate");
  });
});

describe("correcting a pending translation", () => {
  it('"Which language?" → "no, Spanish" translates into Spanish', async () => {
    await say("Translate good night");
    const reply = await say("no, Spanish");
    expect(reply.card).toMatchObject({ type: "translate", original: "good night", toLang: "es" });
  });

  it('"…into French?" → "no, I meant Spanish" switches the language and asks again', async () => {
    await say("Translate to French");
    const ask = await say("no, I meant Spanish");
    expect(ask.card).toBeNull();
    expect(ask.text).toMatch(/translate into Spanish/i);

    const reply = await say("good morning");
    expect(reply.card).toMatchObject({ type: "translate", original: "good morning", toLang: "es" });
  });

  it('"…into French?" → "actually, good morning" translates the corrected phrase', async () => {
    await say("Translate to French");
    const reply = await say("actually, good morning");
    expect(reply.card).toMatchObject({ type: "translate", original: "good morning", toLang: "fr" });
  });

  it("a plain answer still completes the request", async () => {
    await say("Translate to French");
    const reply = await say("thank you");
    expect(reply.card).toMatchObject({ type: "translate", original: "thank you", toLang: "fr" });
  });
});
