import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import {
  TEXT_INPUT_MAX_CHARS,
  WS_MAX_PAYLOAD_BYTES,
  wsLimits,
} from "../modules/audio/audio.routes.js";

// vitest.config.ts sets CORS_ORIGINS=http://localhost:5173 for the test run.
const ALLOWED = "http://localhost:5173";

type Outcome =
  | { kind: "rejected"; status: number }
  | { kind: "closed"; code: number; messages: Array<{ type: string; code?: string }> };

describe("WebSocket /api/ws/audio guards", () => {
  let app: FastifyInstance;
  let url: string;
  const defaultLimit = wsLimits.maxMessagesPerSecond;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address !== "object") throw new Error("no port");
    url = `ws://127.0.0.1:${address.port}/api/ws/audio`;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    wsLimits.maxMessagesPerSecond = defaultLimit;
  });

  /** Opens a socket, runs `onSession` after session_id, collects messages until close or timeout. */
  function connect(
    headers: Record<string, string>,
    onSession: (ws: WebSocket) => void = () => undefined,
    waitMs = 1500,
  ): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const messages: Array<{ type: string; code?: string }> = [];
      const timer = setTimeout(() => ws.close(1000), waitMs);
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        res.resume();
        resolve({ kind: "rejected", status: res.statusCode ?? 0 });
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString()) as { type: string; code?: string };
        messages.push(msg);
        if (msg.type === "session_id") onSession(ws);
      });
      ws.on("close", (code) => {
        clearTimeout(timer);
        resolve({ kind: "closed", code, messages });
      });
      ws.on("error", (err) => {
        if (!String(err.message).includes("Unexpected server response")) reject(err);
      });
    });
  }

  it("rejects an upgrade from an origin that is not in CORS_ORIGINS", async () => {
    const out = await connect({ Origin: "https://evil.example" });
    expect(out).toEqual({ kind: "rejected", status: 403 });
  });

  it("rejects an upgrade without an Origin header", async () => {
    const out = await connect({});
    expect(out).toEqual({ kind: "rejected", status: 403 });
  });

  it("accepts an upgrade from an allowed origin", async () => {
    const out = await connect({ Origin: ALLOWED }, (ws) => ws.close(1000));
    expect(out.kind).toBe("closed");
    if (out.kind === "closed") expect(out.messages[0]?.type).toBe("session_id");
  });

  it("rejects text_input over the character cap without answering it", async () => {
    const out = await connect({ Origin: ALLOWED }, (ws) =>
      ws.send(JSON.stringify({ type: "text_input", text: "a".repeat(TEXT_INPUT_MAX_CHARS + 1) })),
    );
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") return;
    expect(out.messages.filter((m) => m.type === "error").map((m) => m.code)).toEqual([
      "text_too_long",
    ]);
    expect(out.messages.some((m) => m.type === "transcript_final")).toBe(false);
  });

  it("still answers text_input at exactly the cap", async () => {
    const out = await connect({ Origin: ALLOWED }, (ws) =>
      ws.send(JSON.stringify({ type: "text_input", text: "a".repeat(TEXT_INPUT_MAX_CHARS) })),
    );
    expect(out.kind).toBe("closed");
    if (out.kind === "closed") {
      expect(out.messages.some((m) => m.type === "transcript_final")).toBe(true);
    }
  });

  it("closes the socket (1009) when a frame exceeds maxPayload", async () => {
    const out = await connect({ Origin: ALLOWED }, (ws) =>
      ws.send(Buffer.alloc(WS_MAX_PAYLOAD_BYTES + 1)),
    );
    expect(out).toMatchObject({ kind: "closed", code: 1009 });
  });

  it("closes the socket (1008) when a client exceeds the per-connection message rate", async () => {
    wsLimits.maxMessagesPerSecond = 5;
    const out = await connect({ Origin: ALLOWED }, (ws) => {
      for (let i = 0; i < 10; i++) ws.send(Buffer.alloc(320));
    });
    expect(out).toMatchObject({ kind: "closed", code: 1008 });
    if (out.kind === "closed") {
      expect(out.messages.filter((m) => m.code === "rate_limited")).toHaveLength(1);
    }
  });
});
