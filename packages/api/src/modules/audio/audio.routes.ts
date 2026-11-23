import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createDeepgramProxy, handleControlMessage, type DeepgramProxy } from "./deepgram.proxy.js";
import { streamTts, type TtsStream } from "./elevenlabs.service.js";
import { handleUtterance } from "../agent/agent.service.js";
import {
  createSession,
  endSession,
  appendTurn,
  getNextTurnIndex,
  getRecentContext,
  type SessionContextTurn,
} from "../session/session.service.js";
import type { ClientAudioMessage, ServerAudioMessage } from "@voice-agent/shared-types";
import { isTurnAborted } from "../../utils/turn-abort.js";
import { checkDailyTokenBudget } from "../../middleware/cost.guard.js";
import { getDailyUsage } from "../../utils/usage-tracker.js";
import { isAllowedOrigin } from "../../config/cors.js";

const MAX_PCM_CHUNK_BYTES = 4096;
/** Same cap as the HTTP text route (agent.routes.ts maxLength). */
export const TEXT_INPUT_MAX_CHARS = 500;
/** ws closes the socket (1009) on a larger frame. PCM frames are ≤ 4 KiB, text_input ≤ ~2 KiB. */
export const WS_MAX_PAYLOAD_BYTES = 16 * 1024;
export const turnLimits = {
  /** Hard ceiling for one turn; the LLM call itself gives up well before this. */
  timeoutMs: 25_000,
};
export const wsLimits = {
  /** Mic audio is ~31 frames/s (512 samples @ 16 kHz); this leaves 3x headroom. */
  maxMessagesPerSecond: 100,
};

/** Runs before the upgrade: replying here means the socket is never opened. */
async function rejectForeignOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isAllowedOrigin(request.headers.origin)) return;
  request.log.warn({ origin: request.headers.origin ?? null }, "WS upgrade origin rejected");
  await reply.code(403).send({ error: "origin_not_allowed" });
}

const wsRoute = { websocket: true, preValidation: rejectForeignOrigin } as const;

/** Abort reason for a turn whose text was merged into the next utterance. */
const MERGED = "merged_with_next_utterance";

type FinalTranscript = Extract<ServerAudioMessage, { type: "transcript_final" }>;

/** "Can I build" + "an animation video?" → "Can I build an animation video?" */
export function mergeTranscripts(first: FinalTranscript, next: FinalTranscript): FinalTranscript {
  return {
    type: "transcript_final",
    text: `${first.text} ${next.text}`.replace(/\s+/g, " ").trim(),
    latencyMs: next.latencyMs,
    ...(next.sinceSpeechEndMs !== undefined ? { sinceSpeechEndMs: next.sinceSpeechEndMs } : {}),
  };
}
/** History used for "summarize everything we discussed". */
const SUMMARY_HISTORY_TURNS = 50;

export async function audioRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.get("/api/ws/audio", wsRoute, (socket: WebSocket, request): void => {
    const ephemeralId = randomUUID();
    const log = request.log.child({
      sessionId: ephemeralId,
      correlationId: request.correlationId,
    });

    log.info("Audio WebSocket connection opened");

    let dbSessionId: string = ephemeralId;
    let proxy: DeepgramProxy | null = null;
    let currentTts: TtsStream | null = null;
    let turnAbort: AbortController | null = null;
    let activeTurn: {
      msg: FinalTranscript;
      controller: AbortController;
      answered: boolean;
    } | null = null;
    const sessionAbort = new AbortController();

    let audioFramesIn = 0;
    let audioBytesIn = 0;
    let framesBeforeProxy = 0;
    let oversizeFrames = 0;

    const sendSafe = (msg: ServerAudioMessage): void => send(socket, msg);

    const abortActiveTurn = (reason: string): void => {
      if (!turnAbort || turnAbort.signal.aborted) return;
      turnAbort.abort(reason);
      log.info({ reason }, "Agent turn aborted");
    };

    const runTurn = async (
      msg: Extract<ServerAudioMessage, { type: "transcript_final" }>,
      signal: AbortSignal,
      sendTurn: (m: ServerAudioMessage) => void,
    ): Promise<void> => {
      sendTurn({ type: "agent_thinking" });

      let turnIndex = 0;
      try {
        turnIndex = await getNextTurnIndex(request.server.prisma, dbSessionId);
      } catch (err) {
        log.warn({ err }, "Could not read turn index — using 0");
      }

      let context: SessionContextTurn[] = [];
      try {
        context = await getRecentContext(request.server.prisma, dbSessionId);
      } catch (err) {
        log.warn({ err }, "Could not load session context");
      }

      if (signal.aborted) return;

      // Same daily Gemini ceiling as the HTTP route's costGuard.
      const exceeded = await checkDailyTokenBudget(msg.text);
      if (signal.aborted) return;
      if (exceeded) {
        log.warn({ limit: exceeded.error.limit }, "Daily token budget reached — turn skipped");
        sendTurn({ type: "error", code: "budget_exceeded", message: exceeded.error.message });
        return;
      }

      let reply;
      let pipelineMs: number;
      try {
        const result = await handleUtterance(
          {
            text: msg.text,
            sessionId: dbSessionId,
            turnIndex,
            sttLatencyMs: msg.latencyMs,
            context,
            loadHistory: () =>
              getRecentContext(request.server.prisma, dbSessionId, SUMMARY_HISTORY_TURNS),
            signal,
          },
          log,
        );
        reply = result.reply;
        pipelineMs = result.pipelineMs;
      } catch (err) {
        if (isTurnAborted(err, signal)) {
          log.info("Agent pipeline aborted — suppressing reply");
          return;
        }
        log.error({ err }, "Agent pipeline failed");
        sendTurn({
          type: "error",
          code: "agent_turn_failed",
          message: err instanceof Error ? err.message : "Agent turn failed",
        });
        return;
      }

      if (signal.aborted) return;

      log.info({ pipelineMs, intent: reply.intent, turnIndex }, "WS agent pipeline done");

      sendTurn({ type: "agent_response", reply });

      void appendTurn(
        request.server.prisma,
        { sessionId: dbSessionId, userTranscript: msg.text, reply },
        turnIndex,
      ).catch((err) => {
        log.error({ err, turnIndex }, "Failed to persist turn");
      });

      currentTts?.cancel();
      try {
        currentTts = streamTts(reply.text, sendSafe, log, dbSessionId);
      } catch (err) {
        log.warn({ err }, "TTS not started");
        currentTts = null;
      }
    };

    /**
     * Runs one turn and guarantees it ends in an agent_response or a visible
     * error. Live, turns whose Gemini call hung were later aborted by the next
     * utterance and their reply suppressed: the user heard nothing.
     */
    const runAgentTurn = async (
      msg: Extract<ServerAudioMessage, { type: "transcript_final" }>,
    ): Promise<void> => {
      const controller = new AbortController();
      turnAbort = controller;
      const turn = { msg, controller, answered: false };
      activeTurn = turn;
      const timer = setTimeout(() => controller.abort("turn_timeout"), turnLimits.timeoutMs);
      const sendTurn = (m: ServerAudioMessage): void => {
        if (m.type === "agent_response" || m.type === "error") turn.answered = true;
        sendSafe(m);
      };
      try {
        await runTurn(msg, controller.signal, sendTurn);
      } catch (err) {
        if (!isTurnAborted(err, controller.signal)) {
          log.error({ err }, "Agent turn crashed");
        }
      } finally {
        clearTimeout(timer);
        if (turnAbort === controller) turnAbort = null;
        if (activeTurn === turn) activeTurn = null;
        const reason = controller.signal.aborted ? String(controller.signal.reason) : null;
        // Merged: the merged turn that follows answers for this one.
        const handedOver =
          reason === "socket_closed" || reason === "socket_error" || reason === MERGED;
        if (!turn.answered && !handedOver) {
          log.warn(
            { reason, textPreview: msg.text.slice(0, 80) },
            "Turn ended without a reply — sending a visible error",
          );
          sendSafe(
            reason === "turn_timeout"
              ? {
                  type: "error",
                  code: "turn_timeout",
                  message: "That took too long to answer. Please ask again.",
                }
              : {
                  type: "error",
                  code: "turn_failed",
                  message: "I could not answer that. Please try again.",
                },
          );
        }
      }
    };

    // One turn at a time. Speech-to-text can finalise one sentence in two
    // pieces ("Can I build" … "an animation video?"); live, each piece got its
    // own reply and the first was wrong. If the next piece arrives before the
    // previous reply was delivered, that reply is cancelled and the merged
    // text is answered once. After a reply was delivered, a new utterance is
    // a new question.
    let pending: FinalTranscript | null = null;
    let pumping = false;

    const pump = async (): Promise<void> => {
      if (pumping) return;
      pumping = true;
      try {
        while (pending && !sessionAbort.signal.aborted) {
          const next = pending;
          pending = null;
          await runAgentTurn(next);
        }
      } finally {
        pumping = false;
      }
    };

    const onFinalTranscript = (msg: ServerAudioMessage): void => {
      if (msg.type !== "transcript_final") return;
      let next: FinalTranscript = msg;
      if (pending) {
        next = mergeTranscripts(pending, msg);
        log.info(
          { textPreview: next.text.slice(0, 120) },
          "Utterance merged into the waiting turn",
        );
      } else if (activeTurn && !activeTurn.answered && !activeTurn.controller.signal.aborted) {
        next = mergeTranscripts(activeTurn.msg, msg);
        activeTurn.controller.abort(MERGED);
        log.info(
          { textPreview: next.text.slice(0, 120) },
          "Utterance continued before the reply — cancelled it, answering the merged text",
        );
      }
      pending = next;
      void pump();
    };

    const setupDone = (async (): Promise<void> => {
      try {
        const created = await createSession(request.server.prisma);
        dbSessionId = created.sessionId;
        log.info({ dbSessionId }, "DB session created");
      } catch (err) {
        log.error({ err }, "Failed to create DB session — using ephemeral");
      }

      let sttSecondsUsedToday = 0;
      try {
        sttSecondsUsedToday = (await getDailyUsage()).sttSeconds;
      } catch (err) {
        log.warn({ err }, "Could not read STT usage — assuming none");
      }

      if (socket.readyState !== socket.OPEN) return;

      try {
        send(socket, { type: "session_id", sessionId: dbSessionId });
        proxy = createDeepgramProxy(
          (msg) => {
            sendSafe(msg);
            onFinalTranscript(msg);
          },
          log,
          dbSessionId,
          sessionAbort.signal,
          { sttSecondsUsedToday },
        );
      } catch (err) {
        log.error({ err }, "Failed to send session_id or create proxy");
        sendSafe({
          type: "error",
          code: "proxy_init_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
        try {
          socket.close();
        } catch {
          // the socket may already be closed; nothing to clean up
        }
      }
    })().catch((err: unknown) => {
      log.error({ err }, "Audio session setup failed");
    });

    const handleClientMessage = (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void => {
      if (!proxy) {
        if (isBinary) framesBeforeProxy += 1;
        return;
      }

      if (isBinary) {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

        if (buffer.byteLength > MAX_PCM_CHUNK_BYTES) {
          oversizeFrames += 1;
          sendSafe({
            type: "error",
            code: "chunk_too_large",
            message: `PCM chunk exceeds ${MAX_PCM_CHUNK_BYTES} bytes`,
          });
          return;
        }

        audioFramesIn += 1;
        audioBytesIn += buffer.byteLength;
        if (audioFramesIn === 1) {
          log.info({ byteLength: buffer.byteLength }, "First audio frame received");
        }

        const arrayBuffer = new ArrayBuffer(buffer.byteLength);
        new Uint8Array(arrayBuffer).set(buffer);
        proxy.sendAudio(arrayBuffer);
        return;
      }

      try {
        const msg = JSON.parse(raw.toString()) as ClientAudioMessage;

        if (
          msg.type === "text_input" &&
          (typeof msg.text !== "string" || msg.text.length > TEXT_INPUT_MAX_CHARS)
        ) {
          sendSafe({
            type: "error",
            code: "text_too_long",
            message: `Text input is limited to ${TEXT_INPUT_MAX_CHARS} characters.`,
          });
          return;
        }

        if (msg.type === "barge_in") {
          // Stop the agent talking. A turn still being answered is kept so
          // the user's question still gets its (visible) reply.
          currentTts?.cancel();
          currentTts = null;
        }

        handleControlMessage(
          msg,
          (m) => {
            sendSafe(m);
            onFinalTranscript(m);
          },
          proxy,
          log,
          dbSessionId,
        );
      } catch (err) {
        log.warn({ err }, "Invalid client JSON message");
        sendSafe({
          type: "error",
          code: "invalid_message",
          message: "Could not parse client message",
        });
      }
    };

    // Per-connection flood guard (fixed 1 s window), counted on arrival.
    let windowStart = Date.now();
    let windowCount = 0;
    let rateLimited = false;

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void => {
      if (rateLimited) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount > wsLimits.maxMessagesPerSecond) {
        rateLimited = true;
        log.warn({ limit: wsLimits.maxMessagesPerSecond }, "WS message rate exceeded — closing");
        sendSafe({
          type: "error",
          code: "rate_limited",
          message: "Too many messages. Please reconnect.",
        });
        socket.close(1008, "rate_limited");
        return;
      }
      void setupDone.then(() => handleClientMessage(raw, isBinary));
    });

    socket.on("close", () => {
      log.info(
        { audioFramesIn, audioBytesIn, framesBeforeProxy, oversizeFrames },
        "Audio WebSocket closed by client",
      );
      abortActiveTurn("socket_closed");
      currentTts?.cancel();
      currentTts = null;
      sessionAbort.abort("socket_closed");

      void setupDone
        .then(() => endSession(request.server.prisma, dbSessionId))
        .catch((err) => {
          log.warn({ err }, "Failed to end session");
        });
    });

    socket.on("error", (err) => {
      log.error({ err }, "Audio WebSocket error");
      abortActiveTurn("socket_error");
      currentTts?.cancel();
      currentTts = null;
      sessionAbort.abort("socket_error");
    });
  });
}

function send(socket: WebSocket, msg: ServerAudioMessage): void {
  if (socket.readyState !== socket.OPEN) return;

  if (msg.type === "tts_chunk") {
    const audio = Buffer.from(msg.audio);
    const frame = Buffer.allocUnsafe(4 + audio.byteLength);
    frame.writeUInt32BE(msg.sequenceNum >>> 0, 0);
    audio.copy(frame, 4);
    socket.send(frame, { binary: true });
    return;
  }

  socket.send(JSON.stringify(msg));
}
