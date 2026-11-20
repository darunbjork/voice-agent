import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { AgentTurnAbortedError } from "../../utils/turn-abort.js";

/**
 * Per-attempt ceiling. Live, flash-lite answers in ~1 s, but about 1 in 3
 * requests hung past 15 s (no response, no error) and others returned 503
 * "high demand". Without a ceiling a hung call left the user in silence until
 * they spoke again and the turn was superseded.
 */
export const GEMINI_ATTEMPT_TIMEOUT_MS = 8_000;
/** Start the fallback model in parallel if the primary has not answered by then. */
export const GEMINI_HEDGE_AFTER_MS = 3_000;

export class GeminiAttemptTimeoutError extends Error {
  constructor(
    public readonly model: string,
    ms: number,
  ) {
    super(`Gemini ${model} did not respond within ${ms} ms`);
    this.name = "GeminiAttemptTimeoutError";
  }
}

export type GeminiAttemptFailure = { model: string; status?: number; message: string };

/** Every model attempt failed (timeout, 5xx, 429, network). */
export class GeminiUnavailableError extends Error {
  constructor(public readonly failures: GeminiAttemptFailure[]) {
    super(
      `Gemini unavailable: ${failures.map((f) => `${f.model} → ${f.status ?? ""} ${f.message}`).join("; ")}`,
    );
    this.name = "GeminiUnavailableError";
  }

  /** All failures were quota/rate limits (429): budget, not a provider fault. */
  get quotaOnly(): boolean {
    return this.failures.length > 0 && this.failures.every((f) => f.status === 429);
  }
}

/** Primary model, then the fallback (if configured and different). */
export function geminiModels(): string[] {
  const models = [env.GEMINI_MODEL];
  const fallback = env.GEMINI_FALLBACK_MODEL.trim();
  if (fallback && fallback !== env.GEMINI_MODEL) models.push(fallback);
  return models;
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err && typeof err.status === "number") {
    return err.status;
  }
  const m = err instanceof Error ? err.message.match(/"code":\s*(\d{3})/) : null;
  return m ? Number(m[1]) : undefined;
}

export type GeminiCallOptions = {
  /** The turn's signal: aborting it cancels every attempt. */
  signal?: AbortSignal;
  log?: FastifyBaseLogger;
  models?: string[];
  attemptTimeoutMs?: number;
  hedgeAfterMs?: number;
};

/**
 * generateContent with a per-attempt timeout and a hedged fallback model.
 * The primary starts immediately; the fallback starts when the primary fails
 * or has not answered within `hedgeAfterMs`. The first success wins and the
 * other attempt is aborted.
 */
export function generateWithFallback(
  ai: GoogleGenAI,
  request: Omit<GenerateContentParameters, "model">,
  options: GeminiCallOptions = {},
): Promise<{ response: GenerateContentResponse; model: string }> {
  const models = options.models ?? geminiModels();
  const attemptTimeoutMs = options.attemptTimeoutMs ?? GEMINI_ATTEMPT_TIMEOUT_MS;
  const hedgeAfterMs = options.hedgeAfterMs ?? GEMINI_HEDGE_AFTER_MS;
  const { signal, log } = options;

  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    const failures: GeminiAttemptFailure[] = [];
    let started = 0;
    let pending = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      signal?.removeEventListener("abort", onTurnAbort);
      for (const c of controllers) if (!c.signal.aborted) c.abort();
      done();
    };

    const onTurnAbort = (): void => {
      finish(() => reject(new AgentTurnAbortedError("Gemini request aborted")));
    };

    const start = (): void => {
      if (settled || started >= models.length) return;
      const model = models[started++]!;
      const ctrl = new AbortController();
      controllers.push(ctrl);
      pending += 1;
      const timer = setTimeout(
        () => ctrl.abort(new GeminiAttemptTimeoutError(model, attemptTimeoutMs)),
        attemptTimeoutMs,
      );

      ai.models
        .generateContent({
          ...request,
          model,
          config: { ...request.config, abortSignal: ctrl.signal },
        })
        .then((response) => {
          clearTimeout(timer);
          finish(() => resolve({ response, model }));
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          pending -= 1;
          if (settled) return;
          const reason: unknown = ctrl.signal.aborted ? ctrl.signal.reason : err;
          const failure: GeminiAttemptFailure = {
            model,
            status: statusOf(reason),
            message: reason instanceof Error ? reason.message.slice(0, 200) : String(reason),
          };
          failures.push(failure);
          log?.warn({ ...failure, attempt: started }, "Gemini attempt failed");
          if (started < models.length) {
            start();
          } else if (pending === 0) {
            finish(() => reject(new GeminiUnavailableError(failures)));
          }
        });
    };

    if (signal?.aborted) {
      reject(new AgentTurnAbortedError("Gemini request aborted before start"));
      return;
    }
    signal?.addEventListener("abort", onTurnAbort, { once: true });

    start();
    if (models.length > 1) hedgeTimer = setTimeout(start, hedgeAfterMs);
  });
}
