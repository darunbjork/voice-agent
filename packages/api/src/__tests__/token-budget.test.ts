import { describe, it, expect, afterEach } from "vitest";
import {
  assertWithinBudget,
  assertDailyBudget,
  estimateTokens,
  BudgetExceededError,
  TOKEN_BUDGETS,
  getDailyLimits,
  isTtsDailyBudgetExhausted,
  isSttDailyBudgetExhausted,
  isBudgetExhaustedStatus,
} from "../utils/token-budget.js";
import { env, envSchema } from "../env.js";

const saved = {
  tokens: env.DAILY_MAX_TOKENS,
  tts: env.DAILY_MAX_TTS_CHARS,
  stt: env.DAILY_MAX_STT_SECONDS,
};

afterEach(() => {
  env.DAILY_MAX_TOKENS = saved.tokens;
  env.DAILY_MAX_TTS_CHARS = saved.tts;
  env.DAILY_MAX_STT_SECONDS = saved.stt;
});

describe("token-budget", () => {
  it("estimates tokens with ~4 chars per token heuristic", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("allows requests inside the per-operation budget", () => {
    expect(() => assertWithinBudget("agent_response", TOKEN_BUDGETS.agent_response)).not.toThrow();
  });

  it("throws BudgetExceededError when over the operation limit", () => {
    expect(() => assertWithinBudget("agent_response", TOKEN_BUDGETS.agent_response + 1)).toThrow(
      BudgetExceededError,
    );
  });

  it("throws BudgetExceededError when daily ceiling would be exceeded", () => {
    const max = getDailyLimits().tokens;
    expect(() => assertDailyBudget(max - 10, 20)).toThrow(BudgetExceededError);
  });

  it("assertDailyBudget allows a request that lands exactly on the ceiling", () => {
    const max = getDailyLimits().tokens;
    expect(() => assertDailyBudget(max - 10, 10)).not.toThrow();
  });

  it("assertDailyBudget follows DAILY_MAX_TOKENS from env", () => {
    env.DAILY_MAX_TOKENS = 100;
    expect(() => assertDailyBudget(95, 6)).toThrow(BudgetExceededError);
    try {
      assertDailyBudget(95, 6);
    } catch (err) {
      expect((err as BudgetExceededError).operation).toBe("daily");
      expect((err as BudgetExceededError).limit).toBe(100);
      expect((err as BudgetExceededError).attempted).toBe(101);
    }
  });

  it("BudgetExceededError carries operation and numbers", () => {
    try {
      assertWithinBudget("agent_classify", 999);
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const budgetErr = err as BudgetExceededError;
      expect(budgetErr.operation).toBe("agent_classify");
      expect(budgetErr.limit).toBe(TOKEN_BUDGETS.agent_classify);
      expect(budgetErr.attempted).toBe(999);
    }
  });
});

describe("daily caps", () => {
  it("schema defaults: 50k tokens, 650 TTS chars, 3600 STT seconds", () => {
    const parsed = envSchema.parse({ DATABASE_URL: "postgresql://x", JWT_SECRET: "x".repeat(32) });
    expect(parsed.DAILY_MAX_TOKENS).toBe(50_000);
    expect(parsed.DAILY_MAX_TTS_CHARS).toBe(650);
    expect(parsed.DAILY_MAX_STT_SECONDS).toBe(3600);
  });

  it("schema reads all three caps from env strings", () => {
    const parsed = envSchema.parse({
      DATABASE_URL: "postgresql://x",
      JWT_SECRET: "x".repeat(32),
      DAILY_MAX_TOKENS: "1000",
      DAILY_MAX_TTS_CHARS: "0",
      DAILY_MAX_STT_SECONDS: "60",
    });
    expect(parsed.DAILY_MAX_TOKENS).toBe(1000);
    expect(parsed.DAILY_MAX_TTS_CHARS).toBe(0);
    expect(parsed.DAILY_MAX_STT_SECONDS).toBe(60);
  });

  it("schema rejects negative caps", () => {
    const res = envSchema.safeParse({
      DATABASE_URL: "postgresql://x",
      JWT_SECRET: "x".repeat(32),
      DAILY_MAX_TTS_CHARS: "-1",
    });
    expect(res.success).toBe(false);
  });

  it("getDailyLimits reflects env at call time", () => {
    env.DAILY_MAX_TOKENS = 1;
    env.DAILY_MAX_TTS_CHARS = 2;
    env.DAILY_MAX_STT_SECONDS = 3;
    expect(getDailyLimits()).toEqual({ tokens: 1, ttsChars: 2, sttSeconds: 3 });
  });

  it("TTS cap is exhausted only when the next reply would overshoot", () => {
    env.DAILY_MAX_TTS_CHARS = 650;
    expect(isTtsDailyBudgetExhausted(600, 50)).toBe(false);
    expect(isTtsDailyBudgetExhausted(600, 51)).toBe(true);
    env.DAILY_MAX_TTS_CHARS = 0;
    expect(isTtsDailyBudgetExhausted(0, 1)).toBe(true);
  });

  it("STT cap is exhausted once used seconds reach the limit", () => {
    env.DAILY_MAX_STT_SECONDS = 3600;
    expect(isSttDailyBudgetExhausted(3599)).toBe(false);
    expect(isSttDailyBudgetExhausted(3600)).toBe(true);
  });

  it("402 and 429 are budget-exhausted statuses; other errors are not", () => {
    expect(isBudgetExhaustedStatus(402)).toBe(true);
    expect(isBudgetExhaustedStatus(429)).toBe(true);
    for (const status of [400, 401, 403, 404, 500, 503]) {
      expect(isBudgetExhaustedStatus(status)).toBe(false);
    }
  });
});
