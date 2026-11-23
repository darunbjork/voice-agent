// The daily token cap is reserved before each LLM call and settled with the
// provider's real usage afterwards. Before, the cap was only checked before a
// turn and counted (as an estimate) after it, so concurrent turns all passed
// the check and overshot the cap.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "../env.js";
import { generateLlm, LLM_RESERVE_REPLY_TOKENS, usageTokens } from "../modules/agent/llm.call.js";
import { BudgetExceededError, estimateTokens } from "../utils/token-budget.js";
import { getDailyUsage, incrementUsage, resetUsageMemory } from "../utils/usage-tracker.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

const saved = {
  key: env.GEMINI_API_KEY,
  fallback: env.GEMINI_FALLBACK_MODEL,
  groq: env.GROQ_API_KEY,
  cap: env.DAILY_MAX_TOKENS,
};

const request = { system: "You are terse.", user: "What is two plus two?", temperature: 0 };
const reservation =
  estimateTokens(request.system) + estimateTokens(request.user) + LLM_RESERVE_REPLY_TOKENS;

beforeEach(() => {
  env.GEMINI_API_KEY = "test-key";
  env.GEMINI_FALLBACK_MODEL = "";
  env.GROQ_API_KEY = "";
  generateContentMock.mockReset();
  resetUsageMemory();
  resetAllCircuits();
});

afterEach(() => {
  env.GEMINI_API_KEY = saved.key;
  env.GEMINI_FALLBACK_MODEL = saved.fallback;
  env.GROQ_API_KEY = saved.groq;
  env.DAILY_MAX_TOKENS = saved.cap;
});

const geminiReply = (text: string, totalTokenCount?: number) => ({
  text,
  candidates: [{ finishReason: "STOP" }],
  ...(totalTokenCount === undefined ? {} : { usageMetadata: { totalTokenCount } }),
});

describe("token reservation around each LLM call", () => {
  it("settles to the provider's reported usage", async () => {
    generateContentMock.mockResolvedValue(geminiReply("Four.", 123));
    await generateLlm(request);
    expect((await getDailyUsage()).tokens).toBe(123);
  });

  it("settles to an estimate when the provider reports no usage", async () => {
    generateContentMock.mockResolvedValue(geminiReply("Four."));
    await generateLlm(request);
    expect((await getDailyUsage()).tokens).toBe(
      estimateTokens(request.system) + estimateTokens(request.user) + estimateTokens("Four."),
    );
  });

  it("releases the reservation when every provider fails", async () => {
    generateContentMock.mockRejectedValue(new Error("upstream 500"));
    await expect(generateLlm(request)).rejects.toThrow();
    expect((await getDailyUsage()).tokens).toBe(0);
  });

  it("refuses before calling the provider when the reservation does not fit", async () => {
    env.DAILY_MAX_TOKENS = 1000;
    await incrementUsage({ tokens: 1000 - reservation + 1 });
    await expect(generateLlm(request)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(generateContentMock).not.toHaveBeenCalled();
    expect((await getDailyUsage()).tokens).toBe(1000 - reservation + 1);
  });

  it("concurrent calls cannot overshoot the cap", async () => {
    env.DAILY_MAX_TOKENS = reservation * 2;
    generateContentMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return geminiReply("Four.", reservation);
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => generateLlm(request)),
    );
    const ok = outcomes.filter((o) => o.status === "fulfilled").length;
    const refused = outcomes.filter(
      (o) => o.status === "rejected" && o.reason instanceof BudgetExceededError,
    ).length;

    expect(ok).toBe(2);
    expect(refused).toBe(3);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect((await getDailyUsage()).tokens).toBeLessThanOrEqual(env.DAILY_MAX_TOKENS);
  });
});

describe("usageTokens reads both providers' usage shapes", () => {
  it.each([
    [{ totalTokenCount: 321 }, 321], // Gemini usageMetadata
    [{ prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 }, 320], // Groq
    [{ prompt_tokens: 300, completion_tokens: 20 }, 320],
    [undefined, null],
    [{ nonsense: true }, null],
  ])("%j → %s", (usage, expected) => {
    expect(usageTokens(usage)).toBe(expected);
  });
});
