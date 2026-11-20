import WebSocket from "ws";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../env.js";
import { mockTranscriptFinal } from "../../utils/voice-mock.js";
import {
  assertCircuitClosed,
  recordSuccess,
  recordFailure,
  CircuitOpenError,
} from "../../utils/circuit-breaker.js";
import {
  getDailyLimits,
  isBudgetExhaustedStatus,
  isSttDailyBudgetExhausted,
} from "../../utils/token-budget.js";
import { incrementUsage } from "../../utils/usage-tracker.js";
import type { ClientAudioMessage, ServerAudioMessage } from "@voice-agent/shared-types";

const DEEPGRAM_WS_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&endpointing=500&smart_format=true";

/** linear16 mono @ 16 kHz = 2 bytes × 16000 samples per second. */
const PCM_BYTES_PER_SECOND = 32_000;
/** Persist metered STT seconds this often so concurrent sessions see them. */
const STT_FLUSH_EVERY_SECONDS = 10;

const TEXT_INPUT_FALLBACK_MESSAGE =
  "Speech recognition is temporarily unavailable. Use text input.";

export type TranscriptHandler = (msg: ServerAudioMessage) => void;

export interface DeepgramProxyOptions {
  /** Live STT seconds already used today (from the usage tracker). */
  sttSecondsUsedToday?: number;
  /** Deepgram listen endpoint override (tests). */
  endpoint?: string;
}

export interface DeepgramProxy {
  sendAudio(chunk: ArrayBuffer): void;
  close(): void;
  readonly ready: boolean;
}

export function createDeepgramProxy(
  onTranscript: TranscriptHandler,
  log: FastifyBaseLogger,
  sessionId: string,
  signal?: AbortSignal,
  options: DeepgramProxyOptions = {},
): DeepgramProxy {
  return withAbortSignal(buildDeepgramProxy(onTranscript, log, sessionId, options), signal);
}

/** Proxy that ignores audio; the client socket stays open so text_input still works. */
function degradedProxy(onTranscript: TranscriptHandler, code: string): DeepgramProxy {
  onTranscript({ type: "error", code, message: TEXT_INPUT_FALLBACK_MESSAGE });
  return {
    ready: false,
    sendAudio(): void {},
    close(): void {},
  };
}

function withAbortSignal(proxy: DeepgramProxy, signal?: AbortSignal): DeepgramProxy {
  if (!signal) return proxy;
  if (signal.aborted) {
    proxy.close();
    return proxy;
  }
  signal.addEventListener("abort", () => proxy.close(), { once: true });
  return proxy;
}

function buildDeepgramProxy(
  onTranscript: TranscriptHandler,
  log: FastifyBaseLogger,
  sessionId: string,
  options: DeepgramProxyOptions,
): DeepgramProxy {
  if (env.VOICE_MOCK && !env.DEEPGRAM_LIVE) {
    return createMockProxy(onTranscript, log, sessionId);
  }

  try {
    assertCircuitClosed("deepgram");
  } catch (err) {
    if (!(err instanceof CircuitOpenError)) throw err;

    log.warn({ provider: err.provider }, "STT circuit open");
    return degradedProxy(onTranscript, "deepgram_circuit_open");
  }

  const usedToday = options.sttSecondsUsedToday ?? 0;
  if (isSttDailyBudgetExhausted(usedToday)) {
    log.warn(
      { sessionId, usedToday, dailyMaxSttSeconds: getDailyLimits().sttSeconds },
      "STT daily budget reached — text input only",
    );
    return degradedProxy(onTranscript, "stt_budget_exhausted");
  }

  return createLiveProxy(onTranscript, log, sessionId, usedToday, options.endpoint);
}

const MOCK_UTTERANCE_GAP_MS = 500;

function createMockProxy(
  onTranscript: TranscriptHandler,
  log: FastifyBaseLogger,
  sessionId: string,
): DeepgramProxy {
  let closed = false;
  let chunkCount = 0;
  let interimSent = false;
  let utteranceDone = false;
  let lastChunkAt = 0;

  log.info({ sessionId }, "Deepgram proxy started in MOCK mode");

  return {
    get ready() {
      return !closed;
    },

    sendAudio(_chunk: ArrayBuffer): void {
      if (closed) return;

      const now = Date.now();
      if (now - lastChunkAt > MOCK_UTTERANCE_GAP_MS) {
        utteranceDone = false;
        chunkCount = 0;
        interimSent = false;
      }
      lastChunkAt = now;

      if (utteranceDone) return;

      chunkCount += 1;

      if (chunkCount === 3 && !interimSent) {
        interimSent = true;
        onTranscript({
          type: "transcript_interim",
          text: "What is the weather",
        });
      }

      if (chunkCount >= 8) {
        const final = mockTranscriptFinal();
        onTranscript({
          type: "transcript_final",
          text: final.text,
          latencyMs: final.latencyMs,
        });
        utteranceDone = true;
      }
    },

    close(): void {
      closed = true;
      log.info({ chunkCount, finalSent: utteranceDone }, "Mock Deepgram proxy closed");
    },
  };
}

function createLiveProxy(
  onTranscript: TranscriptHandler,
  log: FastifyBaseLogger,
  sessionId: string,
  sttSecondsUsedToday: number,
  endpoint: string = DEEPGRAM_WS_URL,
): DeepgramProxy {
  if (!env.DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY is required when live speech recognition is enabled");
  }

  let closed = false;
  let sawError = false;
  const startTime = Date.now();
  let results = 0;
  let emptyResults = 0;
  let interims = 0;
  let finals = 0;
  /** Set once the handshake was rejected and already reported to the client. */
  let handshakeHandled = false;

  // STT metering: audio bytes forwarded to Deepgram, persisted in whole seconds.
  let dailySeconds = sttSecondsUsedToday;
  let unflushedBytes = 0;
  let budgetCutoff = false;

  const flushUsage = (final: boolean): void => {
    const seconds = final
      ? Math.ceil(unflushedBytes / PCM_BYTES_PER_SECOND)
      : Math.floor(unflushedBytes / PCM_BYTES_PER_SECOND);
    if (seconds <= 0) return;
    unflushedBytes = Math.max(0, unflushedBytes - seconds * PCM_BYTES_PER_SECOND);
    dailySeconds += seconds;
    void incrementUsage({ sttSeconds: seconds })
      .then((updated) => {
        // Pick up seconds metered by other concurrent sessions.
        dailySeconds = Math.max(dailySeconds, updated.sttSeconds);
      })
      .catch((err: unknown) => {
        log.warn({ err, sessionId }, "STT usage increment failed");
      });
  };

  const dg = new WebSocket(endpoint, {
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
    },
  });

  // Handshake rejected (e.g. 402 out of credits, 429 rate-limited). Without
  // this listener ws reports a generic "Unexpected server response" error.
  dg.on("unexpected-response", (_req, res) => {
    const status = res.statusCode ?? 0;
    res.resume();
    handshakeHandled = true;
    sawError = true;
    closed = true;
    if (isBudgetExhaustedStatus(status)) {
      // Out of credits / rate-limited is not a provider fault: no breaker count.
      log.warn({ sessionId, status }, "Deepgram STT budget exhausted — text input only");
      onTranscript({
        type: "error",
        code: "stt_budget_exhausted",
        message: TEXT_INPUT_FALLBACK_MESSAGE,
      });
    } else {
      recordFailure("deepgram");
      log.error({ sessionId, status }, "Deepgram handshake rejected");
      onTranscript({
        type: "error",
        code: "deepgram_error",
        message: `Unexpected server response: ${status}`,
      });
    }
    dg.terminate();
  });

  dg.on("open", () => {
    recordSuccess("deepgram");
    log.info({ sessionId }, "Deepgram live WebSocket open");
  });

  dg.on("message", (data: WebSocket.RawData) => {
    if (closed) return;
    try {
      const msg = JSON.parse(data.toString()) as {
        type?: string;
        is_final?: boolean;
        speech_final?: boolean;
        channel?: {
          alternatives?: Array<{ transcript?: string }>;
        };
      };

      if (msg.type !== "Results") return;

      results += 1;

      const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
      if (!transcript) {
        emptyResults += 1;
        if (emptyResults === 1) {
          log.info(
            { sessionId },
            "Deepgram first empty transcript — mic audio was silent or unrecognisable",
          );
        }
        return;
      }

      if (msg.is_final || msg.speech_final) {
        finals += 1;
        onTranscript({
          type: "transcript_final",
          text: transcript,
          latencyMs: Date.now() - startTime,
        });
      } else {
        interims += 1;
        onTranscript({
          type: "transcript_interim",
          text: transcript,
        });
      }
    } catch (err) {
      log.error({ err, sessionId }, "Failed to parse Deepgram message");
    }
  });

  dg.on("error", (err) => {
    // Already reported (rejected handshake) or we closed it ourselves.
    if (handshakeHandled || closed) return;
    sawError = true;
    recordFailure("deepgram");
    log.error({ err, sessionId }, "Deepgram WebSocket error");
    onTranscript({
      type: "error",
      code: "deepgram_error",
      message: err.message,
    });
  });

  dg.on("close", () => {
    flushUsage(true);
    log.info({ results, emptyResults, interims, finals }, "Deepgram WebSocket closed");
    if (!closed && !sawError) {
      // Server dropped us mid-session — already counted if "error" fired.
      recordFailure("deepgram");
    }
    closed = true;
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    flushUsage(true);
    if (dg.readyState === WebSocket.OPEN) {
      dg.send(JSON.stringify({ type: "CloseStream" }));
      dg.close();
    } else if (dg.readyState === WebSocket.CONNECTING) {
      dg.terminate();
    }
  };

  const cutOffForBudget = (): void => {
    budgetCutoff = true;
    log.warn(
      { sessionId, dailySeconds, dailyMaxSttSeconds: getDailyLimits().sttSeconds },
      "STT daily budget reached mid-session — text input only",
    );
    close();
    onTranscript({
      type: "error",
      code: "stt_budget_exhausted",
      message: TEXT_INPUT_FALLBACK_MESSAGE,
    });
  };

  return {
    get ready() {
      return !closed && dg.readyState === WebSocket.OPEN;
    },

    sendAudio(chunk: ArrayBuffer): void {
      if (closed || budgetCutoff || dg.readyState !== WebSocket.OPEN) return;
      const pendingSeconds = (unflushedBytes + chunk.byteLength) / PCM_BYTES_PER_SECOND;
      if (dailySeconds + pendingSeconds > getDailyLimits().sttSeconds) {
        cutOffForBudget();
        return;
      }
      dg.send(Buffer.from(chunk));
      unflushedBytes += chunk.byteLength;
      if (unflushedBytes >= STT_FLUSH_EVERY_SECONDS * PCM_BYTES_PER_SECOND) flushUsage(false);
    },

    close,
  };
}

export function handleControlMessage(
  msg: ClientAudioMessage,
  onTranscript: TranscriptHandler,
  proxy: DeepgramProxy,
  log: FastifyBaseLogger,
  sessionId: string,
): void {
  switch (msg.type) {
    case "text_input": {
      const final = mockTranscriptFinal(msg.text);
      onTranscript({
        type: "transcript_final",
        text: final.text,
        latencyMs: final.latencyMs,
      });
      break;
    }
    case "barge_in": {
      log.info({ sessionId }, "barge_in received (TTS cancel later)");
      break;
    }
    case "session_end": {
      proxy.close();
      break;
    }
    case "audio_chunk": {
      break;
    }
    default: {
      const _exhaustive: never = msg;
      log.warn({ msg: _exhaustive }, "Unknown client message");
    }
  }
}
