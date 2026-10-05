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
import type { ClientAudioMessage, ServerAudioMessage } from "@voice-agent/shared-types";

const DEEPGRAM_WS_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&endpointing=500&smart_format=true";

export type TranscriptHandler = (msg: ServerAudioMessage) => void;

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
): DeepgramProxy {
  return withAbortSignal(buildDeepgramProxy(onTranscript, log, sessionId), signal);
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
): DeepgramProxy {
  if (env.VOICE_MOCK) {
    return createMockProxy(onTranscript, log, sessionId);
  }

  try {
    assertCircuitClosed("deepgram");
  } catch (err) {
    if (!(err instanceof CircuitOpenError)) throw err;

    log.warn({ provider: err.provider }, "STT circuit open");
    onTranscript({
      type: "error",
      code: "deepgram_circuit_open",
      message: "Speech recognition is temporarily unavailable. Use text input.",
    });

    // Degraded proxy: the socket stays open so text_input still works.
    return {
      ready: false,
      sendAudio(): void {},
      close(): void {},
    };
  }

  return createLiveProxy(onTranscript, log, sessionId);
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
): DeepgramProxy {
  if (!env.DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY is required when VOICE_MOCK=false");
  }

  let closed = false;
  let sawError = false;
  const startTime = Date.now();
  let results = 0;
  let emptyResults = 0;
  let interims = 0;
  let finals = 0;

  const dg = new WebSocket(DEEPGRAM_WS_URL, {
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
    },
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
    if (dg.readyState === WebSocket.OPEN) {
      dg.send(JSON.stringify({ type: "CloseStream" }));
      dg.close();
    }
  };

  return {
    get ready() {
      return !closed && dg.readyState === WebSocket.OPEN;
    },

    sendAudio(chunk: ArrayBuffer): void {
      if (closed || dg.readyState !== WebSocket.OPEN) return;
      dg.send(Buffer.from(chunk));
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
