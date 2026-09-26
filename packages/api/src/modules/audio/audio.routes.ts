import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createDeepgramProxy, handleControlMessage, type DeepgramProxy } from "./deepgram.proxy.js";
import type { ClientAudioMessage, ServerAudioMessage } from "@voice-agent/shared-types";

const MAX_PCM_CHUNK_BYTES = 4096;

export async function audioRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.get("/api/ws/audio", { websocket: true }, (socket: WebSocket, request) => {
    const sessionId = randomUUID();
    const log = request.log.child({ sessionId, correlationId: request.correlationId });

    log.info("Audio WebSocket connection opened");

    send(socket, { type: "session_id", sessionId });

    let proxy: DeepgramProxy | null = null;

    try {
      proxy = createDeepgramProxy((msg) => send(socket, msg), log, sessionId);
    } catch (err) {
      log.error({ err }, "Failed to create Deepgram proxy");
      send(socket, {
        type: "error",
        code: "proxy_init_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
      socket.close();
      return;
    }

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!proxy) return;

      if (isBinary) {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);

        if (buffer.byteLength > MAX_PCM_CHUNK_BYTES) {
          send(socket, {
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
        handleControlMessage(msg, (m) => send(socket, m), proxy, log, sessionId);
      } catch (err) {
        log.warn({ err }, "Invalid client JSON message");
        send(socket, {
          type: "error",
          code: "invalid_message",
          message: "Could not parse client message",
        });
      }
    });

    socket.on("close", () => {
      log.info("Audio WebSocket closed by client");
      proxy?.close();
    });

    socket.on("error", (err) => {
      log.error({ err }, "Audio WebSocket error");
      proxy?.close();
    });
  });
}

function send(socket: WebSocket, msg: ServerAudioMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}
