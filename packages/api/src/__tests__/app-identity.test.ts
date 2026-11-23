// "Who built you?" is answered with the app's real author and repository,
// deterministically (no LLM), and the system prompt carries the same facts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { SYSTEM_PROMPT } from "../modules/agent/gemini.service.js";
import {
  APP_AUTHOR,
  APP_REPO_URL,
  IDENTITY_REPLY,
  identityAnswer,
} from "../modules/agent/app-identity.js";
import { getDailyUsage, resetUsageMemory } from "../utils/usage-tracker.js";

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

const saved = { mock: env.VOICE_MOCK, key: env.GEMINI_API_KEY };
beforeEach(() => {
  env.VOICE_MOCK = false;
  env.GEMINI_API_KEY = "test-key";
  generateContentMock.mockReset();
  generateContentMock.mockResolvedValue({
    text: JSON.stringify({
      reply: "Gustave Eiffel's company built it.",
      intent: "general",
      card: null,
    }),
    candidates: [{ finishReason: "STOP" }],
  });
});
afterEach(() => {
  env.VOICE_MOCK = saved.mock;
  env.GEMINI_API_KEY = saved.key;
});

const say = (text: string) =>
  handleUtterance({ text, sessionId: "id", turnIndex: 0, sttLatencyMs: 0 }, silent).then(
    (r) => r.reply,
  );

describe("app identity", () => {
  it("names the real author and repository", () => {
    expect(APP_AUTHOR).toBe("Darun Mustafa");
    expect(APP_REPO_URL).toBe("https://github.com/darunbjork/voice-agent");
  });

  it("the system prompt states who built the app and where the code is", () => {
    expect(SYSTEM_PROMPT).toContain("built by Darun Mustafa");
    expect(SYSTEM_PROMPT).toContain("github.com/darunbjork/voice-agent");
  });

  it.each([
    "Who built you?",
    "who made this app",
    "Who created this assistant?",
    "Who is your developer?",
    "Where is your source code?",
  ])('"%s" is answered without the LLM', async (text) => {
    const reply = await say(text);
    expect(generateContentMock).not.toHaveBeenCalled();
    expect(reply.text).toContain("Darun Mustafa");
    expect(reply.text).toContain("darunbjork");
  });

  it('"Who built you?" spends no LLM tokens (nothing is reserved or counted)', async () => {
    resetUsageMemory();
    const reply = await say("Who built you?");
    expect(reply.text).toBe(IDENTITY_REPLY);
    expect(generateContentMock).not.toHaveBeenCalled();
    expect((await getDailyUsage()).tokens).toBe(0);
  });

  it.each(["Who built the Eiffel Tower?", "Who made the first computer?"])(
    '"%s" is a normal question',
    async (text) => {
      expect(identityAnswer(text)).toBeNull();
      const reply = await say(text);
      expect(generateContentMock).toHaveBeenCalled();
      expect(reply.text).not.toContain("Darun Mustafa");
    },
  );
});
