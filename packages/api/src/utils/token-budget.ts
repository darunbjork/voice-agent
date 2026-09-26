export type BudgetOperation = "agent_classify" | "agent_response" | "session_summary";

export const TOKEN_BUDGETS: Record<BudgetOperation, number> = {
  agent_classify: 200,
  agent_response: 500,
  session_summary: 300,
} as const;

export const DAILY_MAX_TOKENS = 50_000;

export class BudgetExceededError extends Error {
  readonly operation: BudgetOperation | "daily";
  readonly limit: number;
  readonly attempted: number;

  constructor(operation: BudgetOperation | "daily", limit: number, attempted: number) {
    super(`Budget exceeded for ${operation}: attempted ${attempted} > limit ${limit}`);
    this.name = "BudgetExceededError";
    this.operation = operation;
    this.limit = limit;
    this.attempted = attempted;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function assertWithinBudget(operation: BudgetOperation, estimatedTokens: number): void {
  const limit = TOKEN_BUDGETS[operation];
  if (estimatedTokens > limit) {
    throw new BudgetExceededError(operation, limit, estimatedTokens);
  }
}

export function assertDailyBudget(currentDailyTokens: number, additionalTokens: number): void {
  const projected = currentDailyTokens + additionalTokens;
  if (projected > DAILY_MAX_TOKENS) {
    throw new BudgetExceededError("daily", DAILY_MAX_TOKENS, projected);
  }
}
