import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { mockTtsChunk } from "../../utils/voice-mock.js";
import { assertWithinTtsBudget } from "../../utils/token-budget.js";
import { incrementUsage } from "../../utils/usage-tracker.js";
import type { ServerAudioMessage } from "@voice-agent/shared-types";

export type TtsChunkHandler = (msg: ServerAudioMessage) => void;

export interface TtsStream {
  cancel(): void;
  readonly cancelled: boolean;
}

const ELEVEN_MODEL = "eleven_turbo_v2_5";
const OUTPUT_FORMAT = "pcm_16000";

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
  return streamLiveTts(text, onChunk, log, sessionId);
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
  if (!env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is required when VOICE_MOCK=false");
  }

  let cancelled = false;
  const controller = new AbortController();
  let sequence = 0;

  const voiceId = env.ELEVENLABS_VOICE_ID;
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
    `?output_format=${OUTPUT_FORMAT}&model_id=${ELEVEN_MODEL}`;

  log.info({ sessionId, textLen: text.length, voiceId }, "Live TTS start");

  const emitDone = (): void => {
    onChunk({ type: "tts_done" });
    void incrementUsage({ ttsChars: text.length }).catch((err) => {
      log.warn({ err, sessionId }, "usage increment failed");
    });
  };

  void (async () => {
    try {
      const res = await fetch(url, {
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
        onChunk({
          type: "error",
          code: "tts_http_error",
          message: `ElevenLabs ${res.status}: ${errText}`,
        });
        return;
      }

      const reader = res.body.getReader();
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          const audio = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          onChunk({ type: "tts_chunk", audio, sequenceNum: sequence++ });
        }
      }

      if (!cancelled) {
        emitDone();
        log.info({ sessionId, chunks: sequence }, "Live TTS done");
      }
    } catch (err) {
      if (cancelled) return;
      log.error({ err, sessionId }, "Live TTS failed");
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
