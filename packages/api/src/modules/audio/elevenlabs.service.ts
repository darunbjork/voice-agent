import type { FastifyBaseLogger } from "fastify";
import type { TtsSegment } from "./tts-segments.js";
import { env } from "../../env.js";
import { mockTtsChunk } from "../../utils/voice-mock.js";
import {
  assertWithinTtsBudget,
  getDailyLimits,
  isBudgetExhaustedStatus,
  isTtsDailyBudgetExhausted,
} from "../../utils/token-budget.js";
import { getDailyUsage, incrementUsage } from "../../utils/usage-tracker.js";
import {
  assertCircuitClosed,
  recordSuccess,
  recordFailure,
  CircuitOpenError,
} from "../../utils/circuit-breaker.js";
import type { ServerAudioMessage } from "@voice-agent/shared-types";
import { Pcm16Aligner } from "../../utils/pcm-align.js";

export type TtsChunkHandler = (msg: ServerAudioMessage) => void;

export interface TtsStream {
  cancel(): void;
  readonly cancelled: boolean;
}

const ELEVEN_MODEL = "eleven_turbo_v2_5";
const OUTPUT_FORMAT = "pcm_16000";
const DEEPGRAM_URL =
  "https://api.deepgram.com/v1/speak" +
  "?model=aura-asteria-en&encoding=linear16&sample_rate=16000&container=none";

/** A provider said "out of credits / rate-limited" — not a provider fault. */
class ProviderBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderBudgetError";
  }
}

/**
 * ElevenLabs reports exhausted credits as 401 `quota_exceeded`, and plan or
 * rate problems as 402/429. All of these mean "budget exhausted".
 */
export function isElevenLabsQuotaError(status: number, body: string): boolean {
  return isBudgetExhaustedStatus(status) || /quota_exceeded/i.test(body);
}

/**
 * Reserves `chars` of today's ElevenLabs character budget before the request
 * is sent, so concurrent replies cannot overshoot the cap. Returns false (and
 * leaves usage unchanged) when the reply would not fit.
 */
async function reserveElevenLabsChars(chars: number): Promise<boolean> {
  const before = await getDailyUsage();
  if (isTtsDailyBudgetExhausted(before.ttsChars, chars)) return false;
  const after = await incrementUsage({ ttsChars: chars });
  if (after.ttsChars > getDailyLimits().ttsChars) {
    await incrementUsage({ ttsChars: -chars });
    return false;
  }
  return true;
}

async function releaseElevenLabsChars(chars: number, log: FastifyBaseLogger): Promise<void> {
  await incrementUsage({ ttsChars: -chars }).catch((err: unknown) => {
    log.warn({ err }, "usage refund failed");
  });
}

export type StreamTtsOptions = {
  /**
   * The reply split by language (see tts-segments.ts). ElevenLabs gets one
   * request per segment, with `language_code`; the Aura fallback (English
   * only) and mock mode speak the whole text.
   */
  segments?: TtsSegment[];
};

export function streamTts(
  text: string,
  onChunk: TtsChunkHandler,
  log: FastifyBaseLogger,
  sessionId: string,
  options: StreamTtsOptions = {},
): TtsStream {
  assertWithinTtsBudget(text.length);

  if (env.VOICE_MOCK) {
    return streamMockTts(text, onChunk, log, sessionId);
  }

  const segments = options.segments?.filter((s) => s.text.trim().length > 0);
  try {
    return streamLiveTts(text, onChunk, log, sessionId, segments?.length ? segments : [{ text }]);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      log.warn({ provider: err.provider }, "TTS circuit open — skipping");
      onChunk({
        type: "error",
        code: "tts_circuit_open",
        message: "Text to speech is temporarily unavailable.",
      });
      return {
        cancelled: false,
        cancel(): void {
          onChunk({ type: "tts_done" });
        },
      };
    }
    throw err;
  }
}

function streamMockTts(
  text: string,
  onChunk: TtsChunkHandler,
  log: FastifyBaseLogger,
  sessionId: string,
): TtsStream {
  let cancelled = false;
  const chunkCount = Math.max(3, Math.min(8, Math.ceil(text.length / 20)));
  let sequence = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];

  log.info({ sessionId, chunkCount, textLen: text.length }, "Mock TTS start");

  const emitDone = (): void => {
    onChunk({ type: "tts_done" });
    void incrementUsage({ ttsChars: text.length }).catch((err) => {
      log.warn({ err, sessionId }, "usage increment failed");
    });
  };

  for (let i = 0; i < chunkCount; i++) {
    const t = setTimeout(() => {
      if (cancelled) return;
      try {
        const { audio, sequenceNum } = mockTtsChunk(sequence++);
        onChunk({ type: "tts_chunk", audio, sequenceNum });
        if (i === chunkCount - 1) {
          emitDone();
          log.info({ sessionId }, "Mock TTS done");
        }
      } catch (err) {
        log.error({ err, sessionId }, "Mock TTS chunk failed");
        onChunk({
          type: "error",
          code: "tts_mock_error",
          message: err instanceof Error ? err.message : "Mock TTS error",
        });
      }
    }, 40 * i);
    timers.push(t);
  }

  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      onChunk({ type: "tts_done" });
      log.info({ sessionId }, "Mock TTS cancelled");
    },
  };
}

function streamLiveTts(
  text: string,
  onChunk: TtsChunkHandler,
  log: FastifyBaseLogger,
  sessionId: string,
  segments: TtsSegment[],
): TtsStream {
  const canFallback = Boolean(env.DEEPGRAM_API_KEY);

  if (!env.ELEVENLABS_API_KEY && !canFallback) {
    throw new Error("ELEVENLABS_API_KEY is required when VOICE_MOCK=false");
  }

  let cancelled = false;
  const controller = new AbortController();
  let sequence = 0;

  const voiceId = env.ELEVENLABS_VOICE_ID;
  const elevenUrl =
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
    `?output_format=${OUTPUT_FORMAT}&model_id=${ELEVEN_MODEL}`;

  log.info({ sessionId, textLen: text.length, voiceId }, "Live TTS start");

  // ElevenLabs characters are counted by the up-front reservation; Aura
  // output does not consume the ElevenLabs budget.
  const emitDone = (): void => {
    onChunk({ type: "tts_done" });
  };

  // Pre-flight circuit check for ElevenLabs. Without a fallback this
  // throws synchronously so streamTts can convert it to a wire error.
  let elevenCircuitOk = true;
  if (env.ELEVENLABS_API_KEY) {
    try {
      assertCircuitClosed("elevenlabs");
    } catch {
      elevenCircuitOk = false;
    }
  } else {
    elevenCircuitOk = false;
  }
  if (!elevenCircuitOk && !canFallback) {
    if (env.ELEVENLABS_API_KEY) throw new CircuitOpenError("elevenlabs");
    throw new Error("ELEVENLABS_API_KEY is required when VOICE_MOCK=false");
  }

  type Attempt =
    { ok: true } | { ok: false; code: string; message: string; budgetExhausted: boolean };

  let elevenChunks = 0;

  // Network reads can split a 16-bit sample; only forward whole samples.
  const aligner = new Pcm16Aligner();
  const pushChunk = (value: Uint8Array<ArrayBuffer>): void => {
    const audio = aligner.push(value);
    if (audio) onChunk({ type: "tts_chunk", audio, sequenceNum: sequence++ });
  };

  /** Segments ElevenLabs finished; a fallback speaks only the rest. */
  let segmentsDone = 0;
  const remainingText = (): string =>
    segmentsDone === 0
      ? text
      : segments
          .slice(segmentsDone)
          .map((s) => s.text)
          .join(" ");

  /** One request per segment, in order, into the same audio stream. */
  const attemptElevenLabs = async (): Promise<Attempt> => {
    for (const segment of segments) {
      if (cancelled) break;
      const res = await fetch(elevenUrl, {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: segment.text,
          model_id: ELEVEN_MODEL,
          voice_settings: { stability: 0.4, similarity_boost: 0.75 },
          // Turbo v2.5 enforces the language: "god natt" is spoken as Swedish.
          ...(segment.languageCode ? { language_code: segment.languageCode } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        return {
          ok: false,
          code: "tts_http_error",
          message: `ElevenLabs ${res.status}: ${errText}`,
          budgetExhausted: isElevenLabsQuotaError(res.status, errText),
        };
      }

      const reader = res.body.getReader();
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          elevenChunks += 1;
          pushChunk(value);
        }
      }
      segmentsDone += 1;
    }
    return { ok: true };
  };

  const attemptDeepgramAura = async (): Promise<void> => {
    const res = await fetch(DEEPGRAM_URL, {
      method: "POST",
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: remainingText() }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => res.statusText);
      const message = `Deepgram ${res.status}: ${errText}`;
      throw isBudgetExhaustedStatus(res.status)
        ? new ProviderBudgetError(message)
        : new Error(message);
    }

    const reader = res.body.getReader();
    while (!cancelled) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) pushChunk(value);
    }
  };

  const budgetExhaustedError = (message: string): void => {
    onChunk({ type: "error", code: "tts_budget_exhausted", message });
  };

  void (async () => {
    if (elevenCircuitOk) {
      let reserved: boolean;
      try {
        reserved = await reserveElevenLabsChars(text.length);
      } catch (err) {
        // Cannot prove the reply fits the cap — do not spend ElevenLabs credits.
        log.warn({ err, sessionId }, "TTS usage reservation failed — skipping ElevenLabs");
        reserved = false;
      }
      if (cancelled) {
        if (reserved) await releaseElevenLabsChars(text.length, log);
        return;
      }

      if (!reserved) {
        log.info(
          { sessionId, dailyMaxTtsChars: getDailyLimits().ttsChars },
          "ElevenLabs daily character budget reached — routing to Deepgram Aura",
        );
        if (!canFallback) {
          budgetExhaustedError("Daily ElevenLabs character budget reached.");
          return;
        }
      } else {
        let attempt: Attempt;
        try {
          attempt = await attemptElevenLabs();
        } catch (err) {
          attempt = {
            ok: false,
            code: "tts_stream_error",
            message: err instanceof Error ? err.message : "ElevenLabs request failed",
            budgetExhausted: false,
          };
        }

        if (attempt.ok) {
          if (cancelled) return;
          recordSuccess("elevenlabs");
          emitDone();
          log.info(
            { sessionId, chunks: sequence, oddChunks: aligner.oddChunks },
            "Live TTS done (ElevenLabs)",
          );
          return;
        }

        // Nothing was synthesised, so nothing was billed — give the chars back.
        if (elevenChunks === 0) await releaseElevenLabsChars(text.length, log);
        if (cancelled) return;

        if (attempt.budgetExhausted) {
          // Out of credits / rate-limited is not a provider fault: no breaker count.
          log.warn({ sessionId, reason: attempt.message }, "ElevenLabs budget exhausted");
        } else {
          recordFailure("elevenlabs");
        }

        if (!canFallback) {
          onChunk({
            type: "error",
            code: attempt.budgetExhausted ? "tts_budget_exhausted" : attempt.code,
            message: attempt.message,
          });
          return;
        }
        log.warn(
          { sessionId, reason: attempt.message },
          "ElevenLabs failed — falling back to Deepgram Aura",
        );
      }
    } else {
      log.info({ sessionId }, "Using Deepgram Aura TTS (ElevenLabs unavailable)");
    }

    // A partial ElevenLabs stream may have left half a sample behind.
    aligner.reset();
    try {
      await attemptDeepgramAura();
      if (cancelled) return;
      recordSuccess("deepgram");
      emitDone();
      log.info(
        { sessionId, chunks: sequence, oddChunks: aligner.oddChunks },
        "Live TTS done (Deepgram Aura)",
      );
    } catch (err) {
      if (cancelled) return;
      if (err instanceof ProviderBudgetError) {
        log.warn({ sessionId, reason: err.message }, "Deepgram Aura budget exhausted");
        budgetExhaustedError(err.message);
        return;
      }
      recordFailure("deepgram");
      log.error({ err, sessionId, provider: "deepgram" }, "TTS failed");
      onChunk({
        type: "error",
        code: "tts_stream_error",
        message: err instanceof Error ? err.message : "TTS failed",
      });
    }
  })();

  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      onChunk({ type: "tts_done" });
      log.info({ sessionId }, "Live TTS cancelled");
    },
  };
}
