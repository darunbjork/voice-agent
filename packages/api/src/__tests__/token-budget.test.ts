import { describe, it, expect } from "vitest";
import {
  assertWithinBudget,
  assertDailyBudget,
  estimateTokens,
  BudgetExceededError,
  TOKEN_BUDGETS,
  DAILY_MAX_TOKENS,
} from "../utils/token-budget.js";

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
    expect(() => assertDailyBudget(DAILY_MAX_TOKENS - 10, 20)).toThrow(BudgetExceededError);
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
