import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { mockTtsChunk } from "../../utils/voice-mock.js";
import { assertWithinTtsBudget } from "../../utils/token-budget.js";
import { incrementUsage } from "../../utils/usage-tracker.js";
import {
  assertCircuitClosed,
  recordSuccess,
  recordFailure,
  CircuitOpenError,
  type ProviderName,
} from "../../utils/circuit-breaker.js";
import type { ServerAudioMessage } from "@voice-agent/shared-types";

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

export function streamTts(
  text: string,
  onChunk: TtsChunkHandler,
  log: FastifyBaseLogger,
  sessionId: string,
): TtsStream {
  assertWithinTtsBudget(text.length);

  if (env.VOICE_MOCK) {
    return streamMockTts(text, onChunk, log, sessionId);
  }

  try {
    return streamLiveTts(text, onChunk, log, sessionId);
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

  const emitDone = (): void => {
    onChunk({ type: "tts_done" });
    void incrementUsage({ ttsChars: text.length }).catch((err) => {
      log.warn({ err, sessionId }, "usage increment failed");
    });
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

  type Attempt = { ok: true } | { ok: false; code: string; message: string };

  const pushChunk = (value: Uint8Array<ArrayBuffer>): void => {
    const audio = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    onChunk({ type: "tts_chunk", audio, sequenceNum: sequence++ });
  };

  const attemptElevenLabs = async (): Promise<Attempt> => {
    const res = await fetch(elevenUrl, {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.75 },
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => res.statusText);
      return { ok: false, code: "tts_http_error", message: `ElevenLabs ${res.status}: ${errText}` };
    }

    const reader = res.body.getReader();
    while (!cancelled) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) pushChunk(value);
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
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Deepgram ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    while (!cancelled) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) pushChunk(value);
    }
  };

  void (async () => {
    let activeProvider: ProviderName = elevenCircuitOk ? "elevenlabs" : "deepgram";

    if (elevenCircuitOk) {
      let attempt: Attempt;
      try {
        attempt = await attemptElevenLabs();
      } catch (err) {
        attempt = {
          ok: false,
          code: "tts_stream_error",
          message: err instanceof Error ? err.message : "ElevenLabs request failed",
        };
      }
      if (cancelled) return;

      if (attempt.ok) {
        recordSuccess("elevenlabs");
        emitDone();
        log.info({ sessionId, chunks: sequence }, "Live TTS done (ElevenLabs)");
        return;
      }

      recordFailure("elevenlabs");
      if (!canFallback) {
        onChunk({ type: "error", code: attempt.code, message: attempt.message });
        return;
      }
      log.warn(
        { sessionId, reason: attempt.message },
        "ElevenLabs failed — falling back to Deepgram Aura",
      );
      activeProvider = "deepgram";
    } else {
      log.info({ sessionId }, "Using Deepgram Aura TTS (ElevenLabs unavailable)");
    }

    try {
      await attemptDeepgramAura();
      if (cancelled) return;
      recordSuccess("deepgram");
      emitDone();
      log.info({ sessionId, chunks: sequence }, "Live TTS done (Deepgram Aura)");
    } catch (err) {
      if (cancelled) return;
      recordFailure(activeProvider);
      log.error({ err, sessionId, provider: activeProvider }, "TTS failed");
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
