import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { AgentTurnAbortedError } from "../../utils/turn-abort.js";
import {
  assertCircuitClosed,
  CircuitOpenError,
  recordFailure,
  recordSuccess,
} from "../../utils/circuit-breaker.js";
import { groqChat } from "./groq.client.js";
import { BudgetExceededError, estimateTokens, getDailyLimits } from "../../utils/token-budget.js";
import { incrementUsage } from "../../utils/usage-tracker.js";

/**
 * Per-attempt ceiling. Live, flash-lite answers in ~1 s, but about 1 in 3
 * requests hung past 15 s and others returned 503 "high demand" — on both
 * Gemini models at once (15:40–15:42 UTC, 20 Nov). Groq is the non-Google
 * last resort.
 */
export const LLM_ATTEMPT_TIMEOUT_MS = 8_000;
/** Start the next provider in parallel if the current one has not answered by then. */
export const LLM_HEDGE_AFTER_MS = 3_000;

/**
 * Lowest thinking level. Replies are one to three spoken sentences; on
 * flash-lite-preview LOW spent ~120 thought tokens on "how many states does
 * the USA have", MINIMAL spends none.
 */
export const GEMINI_THINKING_CONFIG = { thinkingLevel: ThinkingLevel.MINIMAL };

export type LlmProvider = "gemini" | "groq";

export type LlmRequest = {
  /** System prompt, already including the current-date line. */
  system: string;
  user: string;
  temperature: number;
  /** Structured output: constrain the reply to this JSON Schema. */
  json?: { name: string; schema: object; strictSchema: object };
};

export type LlmText = { text: string; finishReason?: string; usage?: unknown };

export type LlmAttempt = {
  provider: LlmProvider;
  model: string;
  run: (signal: AbortSignal) => Promise<LlmText>;
};

export class LlmAttemptTimeoutError extends Error {
  constructor(
    public readonly model: string,
    ms: number,
  ) {
    super(`${model} did not respond within ${ms} ms`);
    this.name = "LlmAttemptTimeoutError";
  }
}

export type LlmAttemptFailure = {
  provider: LlmProvider;
  model: string;
  status?: number;
  message: string;
  /** Not attempted because that provider's circuit is open. */
  skipped?: boolean;
};

/** Every provider attempt failed (timeout, 5xx, 429, network) or was skipped. */
export class LlmUnavailableError extends Error {
  constructor(public readonly failures: LlmAttemptFailure[]) {
    super(
      `LLM unavailable: ${failures
        .map((f) => `${f.provider}/${f.model} → ${f.status ?? ""} ${f.message}`)
        .join("; ")}`,
    );
    this.name = "LlmUnavailableError";
  }

  /** All real failures were rate limits (429): budget, not a provider fault. */
  get quotaOnly(): boolean {
    const real = this.failures.filter((f) => !f.skipped);
    return real.length > 0 && real.every((f) => f.status === 429);
  }
}

export type LlmResult = LlmText & { provider: LlmProvider; model: string };

export type LlmCallOptions = {
  /** The turn's signal: aborting it cancels every attempt. */
  signal?: AbortSignal;
  log?: FastifyBaseLogger;
  attemptTimeoutMs?: number;
  hedgeAfterMs?: number;
};

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    return err.status;
  }
  const m = err instanceof Error ? err.message.match(/"code":\s*(\d{3})/) : null;
  return m ? Number(m[1]) : undefined;
}

/** Circuit check without throwing; may claim the half-open probe slot. */
function circuitAllows(provider: LlmProvider): boolean {
  try {
    assertCircuitClosed(provider);
    return true;
  } catch (err) {
    if (err instanceof CircuitOpenError) return false;
    throw err;
  }
}

/** Gemini primary, Gemini fallback (if set and different), then Groq (if GROQ_API_KEY). */
export function llmChain(): Array<{ provider: LlmProvider; model: string }> {
  const chain: Array<{ provider: LlmProvider; model: string }> = [];
  if (env.GEMINI_API_KEY) {
    chain.push({ provider: "gemini", model: env.GEMINI_MODEL });
    const fallback = env.GEMINI_FALLBACK_MODEL.trim();
    if (fallback && fallback !== env.GEMINI_MODEL) {
      chain.push({ provider: "gemini", model: fallback });
    }
  }
  if (env.GROQ_API_KEY) chain.push({ provider: "groq", model: env.GROQ_MODEL });
  return chain;
}

function geminiAttempt(model: string, request: LlmRequest): LlmAttempt {
  return {
    provider: "gemini",
    model,
    run: async (signal) => {
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model,
        contents: request.user,
        config: {
          systemInstruction: request.system,
          temperature: request.temperature,
          thinkingConfig: GEMINI_THINKING_CONFIG,
          ...(request.json
            ? { responseMimeType: "application/json", responseJsonSchema: request.json.schema }
            : {}),
          abortSignal: signal,
        },
      });
      return {
        text: response.text ?? "",
        finishReason: response.candidates?.[0]?.finishReason,
        usage: response.usageMetadata,
      };
    },
  };
}

function groqAttempt(model: string, request: LlmRequest): LlmAttempt {
  return {
    provider: "groq",
    model,
    run: (signal) =>
      groqChat({
        model,
        system: request.system,
        user: request.user,
        temperature: request.temperature,
        json: request.json
          ? { name: request.json.name, schema: request.json.strictSchema }
          : undefined,
        signal,
      }),
  };
}

/**
 * One LLM request through the provider chain (Gemini → Gemini fallback →
 * Groq) with a per-attempt timeout and hedging. Throws CircuitOpenError when
 * every provider's circuit is open, LlmUnavailableError when every attempt
 * failed, AgentTurnAbortedError when the turn was cancelled.
 */
export async function generateLlm(
  request: LlmRequest,
  options: LlmCallOptions = {},
): Promise<LlmResult> {
  const attempts = llmChain().map(({ provider, model }) =>
    provider === "gemini" ? geminiAttempt(model, request) : groqAttempt(model, request),
  );
  if (attempts.length === 0) throw new LlmUnavailableError([]);

  const inputTokens = estimateTokens(request.system) + estimateTokens(request.user);
  const reserved = await reserveTokens(inputTokens + LLM_RESERVE_REPLY_TOKENS);
  let result: LlmResult;
  try {
    result = await runWithFallback(attempts, options);
  } catch (err) {
    // Nothing came back, so nothing is counted against the cap.
    await settleTokens(reserved, 0, options.log);
    throw err;
  }
  const actual = usageTokens(result.usage) ?? inputTokens + estimateTokens(result.text);
  await settleTokens(reserved, actual, options.log);
  return result;
}

/**
 * Upper bound reserved for the reply on top of the prompt estimate: a spoken
 * reply is at most 600 characters (~150 tokens) plus JSON and minimal thinking.
 */
export const LLM_RESERVE_REPLY_TOKENS = 300;

/**
 * Claims `tokens` of today's cap before the call (increment, then check, so
 * concurrent calls cannot all pass). Throws BudgetExceededError and gives the
 * claim back when it does not fit.
 */
async function reserveTokens(tokens: number): Promise<number> {
  const limit = getDailyLimits().tokens;
  const after = await incrementUsage({ tokens });
  if (after.tokens > limit) {
    await incrementUsage({ tokens: -tokens });
    throw new BudgetExceededError("daily", limit, after.tokens);
  }
  return tokens;
}

/** Replaces the reservation with what the call really used. */
async function settleTokens(
  reserved: number,
  actual: number,
  log?: FastifyBaseLogger,
): Promise<void> {
  const delta = actual - reserved;
  if (delta === 0) return;
  await incrementUsage({ tokens: delta }).catch((err: unknown) => {
    log?.warn({ err, reserved, actual }, "token usage settlement failed");
  });
}

/** Total tokens from Gemini `usageMetadata` or Groq `usage`; null when absent. */
export function usageTokens(usage: unknown): number | null {
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && v >= 0 ? v : null);
  const total = num(u.totalTokenCount) ?? num(u.total_tokens);
  if (total !== null) return total;
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  return prompt !== null && completion !== null ? prompt + completion : null;
}

type Outcome = "success" | "failure" | "quota" | "cancelled" | "skipped";

/**
 * Runs `attempts` in order: the next one starts as soon as the previous fails
 * or has not answered within `hedgeAfterMs`. The first success wins and the
 * others are aborted. Circuit breakers are settled per provider afterwards:
 * success → recordSuccess; only non-429 failures → one recordFailure.
 */
export function runWithFallback(
  attempts: LlmAttempt[],
  options: LlmCallOptions = {},
): Promise<LlmResult> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? LLM_ATTEMPT_TIMEOUT_MS;
  const hedgeAfterMs = options.hedgeAfterMs ?? LLM_HEDGE_AFTER_MS;
  const { signal, log } = options;

  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    const failures: LlmAttemptFailure[] = [];
    const outcomes: Array<{ provider: LlmProvider; outcome: Outcome }> = [];
    let next = 0;
    let pending = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

    const settleBreakers = (): void => {
      for (const provider of new Set(outcomes.map((o) => o.provider))) {
        const mine = outcomes.filter((o) => o.provider === provider).map((o) => o.outcome);
        if (mine.includes("success")) recordSuccess(provider);
        else if (mine.includes("failure")) recordFailure(provider);
      }
    };

    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      signal?.removeEventListener("abort", onTurnAbort);
      for (const c of controllers) if (!c.signal.aborted) c.abort();
      settleBreakers();
      done();
    };

    const onTurnAbort = (): void => {
      finish(() => reject(new AgentTurnAbortedError("LLM request aborted")));
    };

    const giveUpIfDone = (): void => {
      if (settled || next < attempts.length || pending > 0) return;
      const real = failures.filter((f) => !f.skipped);
      finish(() =>
        reject(
          real.length === 0 && failures.length > 0
            ? new CircuitOpenError(failures[0]!.provider)
            : new LlmUnavailableError(failures),
        ),
      );
    };

    const start = (): void => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      hedgeTimer = null;
      if (settled) return;

      // Skip providers whose circuit is open, straight to the next one.
      let attempt: LlmAttempt | undefined;
      while (next < attempts.length) {
        const candidate = attempts[next++]!;
        if (circuitAllows(candidate.provider)) {
          attempt = candidate;
          break;
        }
        failures.push({
          provider: candidate.provider,
          model: candidate.model,
          message: "circuit open",
          skipped: true,
        });
        outcomes.push({ provider: candidate.provider, outcome: "skipped" });
      }
      if (!attempt) {
        giveUpIfDone();
        return;
      }

      const { provider, model } = attempt;
      const ctrl = new AbortController();
      controllers.push(ctrl);
      pending += 1;
      const timer = setTimeout(
        () => ctrl.abort(new LlmAttemptTimeoutError(model, attemptTimeoutMs)),
        attemptTimeoutMs,
      );
      if (next < attempts.length) hedgeTimer = setTimeout(start, hedgeAfterMs);

      attempt
        .run(ctrl.signal)
        .then((text) => {
          clearTimeout(timer);
          pending -= 1;
          if (settled) {
            outcomes.push({ provider, outcome: "cancelled" });
            return;
          }
          outcomes.push({ provider, outcome: "success" });
          finish(() => resolve({ ...text, provider, model }));
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          pending -= 1;
          if (settled) {
            outcomes.push({ provider, outcome: "cancelled" });
            return;
          }
          const reason: unknown = ctrl.signal.aborted ? ctrl.signal.reason : err;
          const failure: LlmAttemptFailure = {
            provider,
            model,
            status: statusOf(reason),
            message: reason instanceof Error ? reason.message.slice(0, 200) : String(reason),
          };
          failures.push(failure);
          // A 429 means "budget exhausted", not a broken provider.
          outcomes.push({ provider, outcome: failure.status === 429 ? "quota" : "failure" });
          log?.warn({ ...failure }, "LLM attempt failed");
          if (next < attempts.length) start();
          else giveUpIfDone();
        });
    };

    if (signal?.aborted) {
      reject(new AgentTurnAbortedError("LLM request aborted before start"));
      return;
    }
    signal?.addEventListener("abort", onTurnAbort, { once: true });
    start();
  });
}
