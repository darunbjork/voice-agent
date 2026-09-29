import type { FastifyInstance, FastifyPluginOptions } from "fastify";
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

const MAX_PCM_CHUNK_BYTES = 4096;

export async function audioRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.get("/api/ws/audio", { websocket: true }, (socket: WebSocket, request): void => {
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
    const sessionAbort = new AbortController();

    const sendSafe = (msg: ServerAudioMessage): void => send(socket, msg);

    const abortActiveTurn = (reason: string): void => {
      if (!turnAbort || turnAbort.signal.aborted) return;
      turnAbort.abort(reason);
      log.info({ reason }, "Agent turn aborted");
    };

    const runTurn = async (
      msg: Extract<ServerAudioMessage, { type: "transcript_final" }>,
      signal: AbortSignal,
    ): Promise<void> => {
      sendSafe({ type: "agent_thinking" });

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
        sendSafe({
          type: "error",
          code: "agent_turn_failed",
          message: err instanceof Error ? err.message : "Agent turn failed",
        });
        return;
      }

      if (signal.aborted) return;

      log.info({ pipelineMs, intent: reply.intent, turnIndex }, "WS agent pipeline done");

      sendSafe({ type: "agent_response", reply });

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

    const runAgentTurn = async (
      msg: Extract<ServerAudioMessage, { type: "transcript_final" }>,
    ): Promise<void> => {
      const controller = new AbortController();
      turnAbort = controller;
      try {
        await runTurn(msg, controller.signal);
      } catch (err) {
        if (!isTurnAborted(err, controller.signal)) throw err;
      } finally {
        if (turnAbort === controller) turnAbort = null;
      }
    };

    const onFinalTranscript = (msg: ServerAudioMessage): void => {
      if (msg.type !== "transcript_final") return;
      abortActiveTurn("superseded_by_new_utterance");
      void runAgentTurn(msg);
    };

    const setupDone = (async (): Promise<void> => {
      try {
        const created = await createSession(request.server.prisma);
        dbSessionId = created.sessionId;
        log.info({ dbSessionId }, "DB session created");
      } catch (err) {
        log.error({ err }, "Failed to create DB session — using ephemeral");
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
      if (!proxy) return;

      if (isBinary) {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

        if (buffer.byteLength > MAX_PCM_CHUNK_BYTES) {
          sendSafe({
            type: "error",
            code: "chunk_too_large",
            message: `PCM chunk exceeds ${MAX_PCM_CHUNK_BYTES} bytes`,
          });
          return;
        }

        const arrayBuffer = new ArrayBuffer(buffer.byteLength);
        new Uint8Array(arrayBuffer).set(buffer);
        proxy.sendAudio(arrayBuffer);
        return;
      }

      try {
        const msg = JSON.parse(raw.toString()) as ClientAudioMessage;

        if (msg.type === "barge_in") {
          abortActiveTurn("barge_in");
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

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void => {
      void setupDone.then(() => handleClientMessage(raw, isBinary));
    });

    socket.on("close", () => {
      log.info("Audio WebSocket closed by client");
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
