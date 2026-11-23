// A pending translation is handled before the code-answered questions
// (identity, day counts). After "What would you like me to translate into
// French?", the next utterance IS the phrase — even if it looks like
// "How many days until Christmas?" or "Who built you?".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  handleUtterance({ text, sessionId: "pbd", turnIndex: 0, sttLatencyMs: 0 }, silent).then(
    (r) => r.reply,
  );

beforeEach(() => {
  resetPendingRequests();
  vi.useFakeTimers({ now: new Date("2026-11-21T10:00:00Z"), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pending translation comes first", () => {
  it('"How many days until Christmas?" as the phrase is translated, not answered', async () => {
    await say("Translate to French");
    const reply = await say("How many days until Christmas?");
    expect(reply.intent).toBe("translate");
    expect(reply.card).toMatchObject({ type: "translate", toLang: "fr" });
    expect(reply.card?.type === "translate" && reply.card.original).toMatch(
      /how many days until christmas/i,
    );
    expect(reply.text).not.toContain("days until Christmas Day (");
  });

  it('"Who built you?" as the phrase is translated, not answered', async () => {
    await say("Translate to French");
    const reply = await say("Who built you?");
    expect(reply.intent).toBe("translate");
    expect(reply.card).toMatchObject({ type: "translate", toLang: "fr" });
    expect(reply.text).not.toContain("Darun Mustafa");
  });

  it("cancel still wins over everything while a translation is pending", async () => {
    await say("Translate to French");
    const reply = await say("never mind");
    expect(reply.card).toBeNull();
    expect(reply.text).toMatch(/no translation/i);
  });

  it("waiting for a language, a question that is not one is answered normally", async () => {
    await say("Translate good night");
    const reply = await say("How many days until Christmas?");
    expect(reply.card).toBeNull();
    expect(reply.text).toContain("34 days until Christmas Day");
  });
});

describe("an explicit translation request is never answered in code", () => {
  it.each([
    ["Translate who built you into French", "who built you"],
    ["Translate how many days until Christmas to Spanish", "how many days until christmas"],
  ])('"%s" is translated', async (text, original) => {
    const reply = await say(text);
    expect(reply.intent).toBe("translate");
    expect(reply.card?.type === "translate" && reply.card.original.toLowerCase()).toBe(original);
    expect(reply.text).not.toContain("Darun Mustafa");
    expect(reply.text).not.toContain("Christmas Day (");
  });
});

describe("without a pending translation, nothing changes", () => {
  it('"How many days until Christmas?" gets the date answer', async () => {
    const reply = await say("How many days until Christmas?");
    expect(reply.intent).toBe("general");
    expect(reply.text).toBe("There are 34 days until Christmas Day (Friday, 25 December 2026).");
  });

  it('"Who built you?" gets the identity answer', async () => {
    const reply = await say("Who built you?");
    expect(reply.intent).toBe("help");
    expect(reply.text).toContain("Darun Mustafa");
  });
});
