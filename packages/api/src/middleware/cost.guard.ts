import type { FastifyRequest, FastifyReply } from "fastify";
import { getDailyUsage } from "../utils/usage-tracker.js";
import { assertDailyBudget, BudgetExceededError, estimateTokens } from "../utils/token-budget.js";

/**
 * Checks the daily Gemini token ceiling for a turn. Returns the error when the
 * turn would exceed it, or null when it may proceed. Shared by the HTTP route
 * guard and the WebSocket audio path.
 */
export async function checkDailyTokenBudget(
  text: string,
): Promise<{ error: BudgetExceededError; currentTokens: number } | null> {
  const usage = await getDailyUsage();
  try {
    assertDailyBudget(usage.tokens, Math.max(1, estimateTokens(text)));
    return null;
  } catch (err) {
    if (err instanceof BudgetExceededError) return { error: err, currentTokens: usage.tokens };
    throw err;
  }
}

export async function costGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body as { text?: unknown } | undefined;
  const text = typeof body?.text === "string" ? body.text : "";
  const exceeded = await checkDailyTokenBudget(text);
  if (exceeded) {
    await reply.status(429).header("Retry-After", "3600").send({
      error: "budget_exceeded",
      message: exceeded.error.message,
      limit: exceeded.error.limit,
      current: exceeded.currentTokens,
    });
  }
}
