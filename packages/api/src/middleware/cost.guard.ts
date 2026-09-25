// packages/api/src/middleware/cost.guard.ts
// preHandler: rejects the request once the daily token budget is exhausted.

import type { FastifyRequest, FastifyReply } from "fastify";
import { getDailyUsage } from "../utils/usage-tracker.js";
import { DAILY_MAX_TOKENS, BudgetExceededError } from "../utils/token-budget.js";

export async function costGuard(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const usage = getDailyUsage();
  if (usage.tokens >= DAILY_MAX_TOKENS) {
    const err = new BudgetExceededError(
      "daily",
      DAILY_MAX_TOKENS,
      usage.tokens,
    );
    await reply
      .status(429)
      .header("Retry-After", "3600")
      .send({
        error: "budget_exceeded",
        message: err.message,
        limit: DAILY_MAX_TOKENS,
        current: usage.tokens,
      });
  }
}
