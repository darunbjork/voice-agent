import { env } from "../env.js";

export type BudgetOperation = "agent_classify" | "agent_response" | "session_summary" | "tts_reply";

export const TOKEN_BUDGETS: Record<BudgetOperation, number> = {
  agent_classify: 200,
  // Per call, not per day: system prompt (~860 tokens with the date line) +
  // the utterance (<=500 chars) + history trimmed to whatever is left.
  agent_response: 1500,
  session_summary: 300,
  tts_reply: 600,
} as const;

/** Characters, not tokens. ElevenLabs bills per character. */
export const TTS_MAX_CHARS_PER_REPLY = 600;

export type DailyLimits = {
  /** Gemini tokens per UTC day (estimated). */
  tokens: number;
  /** ElevenLabs characters per UTC day. Over the cap, TTS goes to Deepgram Aura. */
  ttsChars: number;
  /** Deepgram live STT seconds per UTC day. Over the cap, clients fall back to text input. */
  sttSeconds: number;
};

/** Read at call time so limits follow env (and tests can adjust them). */
export function getDailyLimits(): DailyLimits {
  return {
    tokens: env.DAILY_MAX_TOKENS,
    ttsChars: env.DAILY_MAX_TTS_CHARS,
    sttSeconds: env.DAILY_MAX_STT_SECONDS,
  };
}

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

/**
 * Daily Gemini token ceiling. Throws when today's usage plus this request's
 * estimate would exceed DAILY_MAX_TOKENS. Used by the HTTP cost guard and the
 * WebSocket turn guard.
 */
export function assertDailyBudget(currentDailyTokens: number, additionalTokens: number): void {
  const limit = getDailyLimits().tokens;
  const projected = currentDailyTokens + additionalTokens;
  if (projected > limit) {
    throw new BudgetExceededError("daily", limit, projected);
  }
}

/** True when sending `additionalChars` more to ElevenLabs would exceed today's cap. */
export function isTtsDailyBudgetExhausted(usedChars: number, additionalChars: number): boolean {
  return usedChars + additionalChars > getDailyLimits().ttsChars;
}

/** True once today's live STT seconds have reached the cap. */
export function isSttDailyBudgetExhausted(usedSeconds: number): boolean {
  return usedSeconds >= getDailyLimits().sttSeconds;
}

/**
 * Pre-flight check for a TTS reply. Uses character count, not tokens.
 * Throws BudgetExceededError with operation "tts_reply" if the reply
 * would exceed the per-reply cap.
 */
export function assertWithinTtsBudget(characterCount: number): void {
  if (characterCount > TTS_MAX_CHARS_PER_REPLY) {
    throw new BudgetExceededError("tts_reply", TTS_MAX_CHARS_PER_REPLY, characterCount);
  }
}

/**
 * HTTP status codes that mean "out of credits / rate-limited", not "provider
 * broken". These skip the circuit breaker and trigger an immediate fallback.
 */
export function isBudgetExhaustedStatus(status: number): boolean {
  return status === 402 || status === 429;
}
