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

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

/**
 * Query for the live listen socket, read from env at connect time.
 * nova-3 gets `keyterm` prompting for tech vocabulary (verified live: "agentic
 * AI and RAG", "Which LLM does this API use", "Deepgram" transcribed exactly,
 * where nova-2 heard "agentic dot ai and RAC", "hell on them", "deep in").
 * nova-2 does not support keyterm, so it gets boosted `keywords` instead.
 */
export function deepgramListenParams(): URLSearchParams {
  const params = new URLSearchParams({
    model: env.DEEPGRAM_MODEL,
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    punctuate: "true",
    smart_format: "true",
    // Silence that ends a finalised segment (is_final / speech_final).
    endpointing: "500",
    // UtteranceEnd after 2 s without words. 1 s and 1.5 s still split live
    // sentences ("Which language is more" … "into tech?"); the server also
    // merges a continuation that arrives before the reply (audio.routes.ts).
    utterance_end_ms: "2000",
    vad_events: "true",
  });
  const nova3 = env.DEEPGRAM_MODEL.startsWith("nova-3");
  for (const term of env.DEEPGRAM_KEYTERMS) {
    if (nova3) params.append("keyterm", term);
    else params.append("keywords", `${term}:2`);
  }
  return params;
}

/** linear16 mono @ 16 kHz = 2 bytes × 16000 samples per second. */
const PCM_BYTES_PER_SECOND = 32_000;
/** Persist metered STT seconds this often so concurrent sessions see them. */
const STT_FLUSH_EVERY_SECONDS = 10;
/** Audio held while the upstream connection opens (~3 s); oldest dropped beyond. */
const MAX_PENDING_BYTES = 3 * PCM_BYTES_PER_SECOND;
/** A close this long after the last audio frame is Deepgram's idle timeout, not a fault. */
const IDLE_CLOSE_THRESHOLD_MS = 5_000;
/** Wait before reconnecting after a failed connection. */
const RECONNECT_BACKOFF_MS = 2_000;
/** Deepgram drops a stream after ~10 s without audio; send KeepAlive well inside that. */
const KEEPALIVE_INTERVAL_MS = 5_000;
const KEEPALIVE_TICK_MS = 1_000;
/** Stop keeping an unused stream alive after this; the next audio frame reconnects. */
const KEEPALIVE_MAX_IDLE_MS = 60_000;
/** Emit an utterance if UtteranceEnd never arrives (e.g. dropped message). */
const UTTERANCE_FLUSH_FALLBACK_MS = 3_000;

const TEXT_INPUT_FALLBACK_MESSAGE =
  "Speech recognition is temporarily unavailable. Use text input.";

export type TranscriptHandler = (msg: ServerAudioMessage) => void;

export interface DeepgramProxyOptions {
  /** Live STT seconds already used today (from the usage tracker). */
  sttSecondsUsedToday?: number;
  /** Deepgram listen endpoint (no query string) override, for tests. */
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
          // Mock STT is not measured; speech "ends" on the chunk that finalises it.
          latencyMs: final.latencyMs,
          sinceSpeechEndMs: 0,
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

/**
 * Live Deepgram proxy. The upstream connection is opened lazily on the first
 * audio frame (not when the browser connects) and re-opened when audio arrives
 * after Deepgram closed an idle stream. Deepgram drops a stream that receives
 * no audio for ~10 s, so connecting eagerly meant a user who waited before
 * pressing the mic lost every word.
 */
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

  /** Session-level: the client ended the session or the budget stopped it. */
  let closed = false;
  let budgetCutoff = false;
  /** Upstream refused for budget reasons (402/429) — do not reconnect. */
  let upstreamExhausted = false;
  let circuitNotified = false;
  let retryAfter = 0;

  let dg: WebSocket | null = null;
  let connections = 0;
  /** Frames waiting for the upstream socket, with their arrival time. */
  const pending: Array<{ buf: Buffer; at: number }> = [];
  let pendingBytes = 0;

  // STT latency is recognition delay only: from the arrival of the audio
  // frame holding the utterance's last word to the arrival of Deepgram's
  // final result for it. Deepgram reports word times as offsets into the
  // current connection's audio, so each forwarded frame is recorded as
  // (offset in seconds, arrival time).
  let audioClock: Array<{ offset: number; at: number }> = [];
  let connectionBytes = 0;
  /** Arrival of the most recent frame (fallback when a result has no word timings). */
  let lastFrameAt: number | null = null;
  /** End of the utterance's last finalised word, and when that final result arrived. */
  let speechEnd: { at: number; finalAt: number } | null = null;

  const arrivalAt = (offset: number): number | null => {
    let lo = 0;
    let hi = audioClock.length - 1;
    let hit: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const entry = audioClock[mid]!;
      if (entry.offset <= offset) {
        hit = entry.at;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hit ?? audioClock[0]?.at ?? null;
  };

  // STT metering: audio bytes forwarded to Deepgram, persisted in whole seconds.
  let dailySeconds = sttSecondsUsedToday;
  let unflushedBytes = 0;
  /** When audio was last forwarded upstream (or the connection started). */
  let lastAudioAt = 0;
  /** When anything (audio or KeepAlive) was last sent upstream. */
  let lastSentAt = 0;

  // Utterance assembly: Deepgram finalises speech in segments (is_final);
  // they are joined and emitted as one transcript_final on UtteranceEnd.
  let segments: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let utterances = 0;

  const clearFlushTimer = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };

  const emitUtterance = (): void => {
    clearFlushTimer();
    if (segments.length === 0) return;
    const text = segments.join(" ");
    segments = [];
    utterances += 1;
    const now = Date.now();
    const endedAt = speechEnd?.at ?? lastFrameAt ?? now;
    const latencyMs = Math.max(1, (speechEnd?.finalAt ?? now) - endedAt);
    speechEnd = null;
    onTranscript({
      type: "transcript_final",
      text,
      latencyMs,
      sinceSpeechEndMs: Math.max(0, now - endedAt),
    });
  };

  const armFlushFallback = (): void => {
    clearFlushTimer();
    if (segments.length === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!closed) emitUtterance();
    }, UTTERANCE_FLUSH_FALLBACK_MS);
  };

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

  const forward = (socket: WebSocket, buf: Buffer, arrivedAt: number): void => {
    audioClock.push({ offset: connectionBytes / PCM_BYTES_PER_SECOND, at: arrivedAt });
    // ~2 min of 32 ms frames; anchors are looked up within seconds of speech.
    if (audioClock.length > 4000) audioClock.splice(0, audioClock.length - 4000);
    connectionBytes += buf.byteLength;
    lastFrameAt = arrivedAt;
    socket.send(buf);
    lastAudioAt = Date.now();
    lastSentAt = lastAudioAt;
    unflushedBytes += buf.byteLength;
    if (unflushedBytes >= STT_FLUSH_EVERY_SECONDS * PCM_BYTES_PER_SECOND) flushUsage(false);
  };

  const enqueue = (buf: Buffer, at: number): void => {
    pending.push({ buf, at });
    pendingBytes += buf.byteLength;
    while (pendingBytes > MAX_PENDING_BYTES && pending.length > 1) {
      pendingBytes -= pending.shift()!.buf.byteLength;
    }
  };

  const connect = (): WebSocket | null => {
    try {
      assertCircuitClosed("deepgram");
    } catch (err) {
      if (!(err instanceof CircuitOpenError)) throw err;
      if (!circuitNotified) {
        circuitNotified = true;
        log.warn({ sessionId }, "STT circuit open — not reconnecting");
        onTranscript({
          type: "error",
          code: "deepgram_circuit_open",
          message: TEXT_INPUT_FALLBACK_MESSAGE,
        });
      }
      return null;
    }
    circuitNotified = false;

    connections += 1;
    const attempt = connections;
    const startTime = Date.now();
    lastAudioAt = startTime;
    lastSentAt = startTime;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    let keepAlives = 0;
    // Deepgram's word offsets restart at 0 on every connection.
    audioClock = [];
    connectionBytes = 0;
    let results = 0;
    let emptyResults = 0;
    let interims = 0;
    let finals = 0;
    /** This connection already reported/handled its own end. */
    let settled = false;

    const socket = new WebSocket(`${endpoint}?${deepgramListenParams().toString()}`, {
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      },
    });

    const fail = (message: string): void => {
      settled = true;
      retryAfter = Date.now() + RECONNECT_BACKOFF_MS;
      recordFailure("deepgram");
      onTranscript({ type: "error", code: "deepgram_error", message });
    };

    // Handshake rejected (e.g. 402 out of credits, 429 rate-limited). Without
    // this listener ws reports a generic "Unexpected server response" error.
    socket.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      pending.length = 0;
      pendingBytes = 0;
      if (isBudgetExhaustedStatus(status)) {
        // Out of credits / rate-limited is not a provider fault: no breaker count.
        settled = true;
        upstreamExhausted = true;
        log.warn({ sessionId, status }, "Deepgram STT budget exhausted — text input only");
        onTranscript({
          type: "error",
          code: "stt_budget_exhausted",
          message: TEXT_INPUT_FALLBACK_MESSAGE,
        });
      } else {
        log.error({ sessionId, status }, "Deepgram handshake rejected");
        fail(`Unexpected server response: ${status}`);
      }
      socket.terminate();
    });

    socket.on("open", () => {
      recordSuccess("deepgram");
      log.info({ sessionId, attempt, buffered: pendingBytes }, "Deepgram live WebSocket open");
      if (closed || budgetCutoff) {
        socket.close();
        return;
      }
      for (const frame of pending.splice(0)) forward(socket, frame.buf, frame.at);
      pendingBytes = 0;

      // Mic paused: keep the stream open so the next words are not lost to
      // Deepgram's idle timeout. Long idles are let go (reconnect on demand).
      keepAlive = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (now - lastAudioAt > KEEPALIVE_MAX_IDLE_MS) return;
        if (now - lastSentAt < KEEPALIVE_INTERVAL_MS) return;
        socket.send(JSON.stringify({ type: "KeepAlive" }));
        lastSentAt = now;
        keepAlives += 1;
      }, KEEPALIVE_TICK_MS);
    });

    socket.on("message", (data: WebSocket.RawData) => {
      if (closed) return;
      try {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          is_final?: boolean;
          speech_final?: boolean;
          channel?: {
            alternatives?: Array<{
              transcript?: string;
              words?: Array<{ start?: number; end?: number }>;
            }>;
          };
        };

        if (msg.type === "UtteranceEnd") {
          emitUtterance();
          return;
        }

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

        if (msg.is_final) {
          // Speech end = the frame holding this segment's last word.
          const end = msg.channel?.alternatives?.[0]?.words?.at(-1)?.end;
          const arrivedAt = Date.now();
          speechEnd = {
            at: (typeof end === "number" ? arrivalAt(end) : null) ?? lastFrameAt ?? arrivedAt,
            finalAt: arrivedAt,
          };
        }

        if (msg.is_final) {
          // A finalised segment, not necessarily the end of the utterance.
          finals += 1;
          segments.push(transcript);
          onTranscript({ type: "transcript_interim", text: segments.join(" ") });
        } else {
          interims += 1;
          onTranscript({
            type: "transcript_interim",
            text: [...segments, transcript].join(" "),
          });
        }
        armFlushFallback();
      } catch (err) {
        log.error({ err, sessionId }, "Failed to parse Deepgram message");
      }
    });

    socket.on("error", (err) => {
      // Already handled (rejected handshake) or we closed it ourselves.
      if (settled || closed) return;
      log.error({ err, sessionId }, "Deepgram WebSocket error");
      fail(err.message);
    });

    socket.on("close", (code: number) => {
      if (keepAlive) clearInterval(keepAlive);
      // Speech finalised just before Deepgram closed still counts as a turn.
      if (!closed) emitUtterance();
      flushUsage(true);
      if (dg === socket) dg = null;
      const idleMs = Date.now() - lastAudioAt;
      log.info(
        {
          sessionId,
          attempt,
          code,
          idleMs,
          results,
          emptyResults,
          interims,
          finals,
          utterances,
          keepAlives,
        },
        "Deepgram WebSocket closed",
      );
      if (settled || closed || budgetCutoff) return;
      // Deepgram closes streams that stop receiving audio (mic off). That is
      // expected; the next audio frame reconnects. Only a drop while audio
      // was flowing counts as a provider failure.
      if (code !== 1000 && idleMs < IDLE_CLOSE_THRESHOLD_MS) {
        retryAfter = Date.now() + RECONNECT_BACKOFF_MS;
        recordFailure("deepgram");
      }
    });

    return socket;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearFlushTimer();
    segments = [];
    pending.length = 0;
    pendingBytes = 0;
    flushUsage(true);
    const socket = dg;
    dg = null;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "CloseStream" }));
      socket.close();
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
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
    /** True while the proxy still accepts audio (it connects on demand). */
    get ready() {
      return !closed && !budgetCutoff && !upstreamExhausted;
    },

    sendAudio(chunk: ArrayBuffer): void {
      if (closed || budgetCutoff || upstreamExhausted) return;
      const pendingSeconds =
        (unflushedBytes + pendingBytes + chunk.byteLength) / PCM_BYTES_PER_SECOND;
      if (dailySeconds + pendingSeconds > getDailyLimits().sttSeconds) {
        cutOffForBudget();
        return;
      }

      const buf = Buffer.from(chunk);
      const arrivedAt = Date.now();
      if (dg?.readyState === WebSocket.OPEN) {
        forward(dg, buf, arrivedAt);
        return;
      }
      if (dg?.readyState === WebSocket.CONNECTING) {
        enqueue(buf, arrivedAt);
        return;
      }
      // No upstream (never opened, or Deepgram closed an idle stream).
      if (Date.now() < retryAfter) return;
      const socket = connect();
      if (!socket) return;
      dg = socket;
      enqueue(buf, arrivedAt);
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
