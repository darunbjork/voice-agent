import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import WebSocket from "ws";

describe("WebSocket /api/ws/audio (mock mode)", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address && typeof address === "object") {
      port = address.port;
    } else {
      throw new Error("Could not determine port");
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("sends session_id on connect and returns mock transcript_final after audio chunks", async () => {
    const messages: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/audio`);

      ws.on("open", () => {
        const silent = new ArrayBuffer(320);
        for (let i = 0; i < 8; i++) {
          ws.send(silent);
        }
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        messages.push(msg);

        if (msg.type === "transcript_final") {
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);

      setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for transcript_final"));
      }, 5000);
    });

    const sessionMsg = messages.find((m) => (m as { type: string }).type === "session_id") as
      { sessionId: string } | undefined;
    expect(sessionMsg?.sessionId).toBeTruthy();

    const finalMsg = messages.find((m) => (m as { type: string }).type === "transcript_final") as
      { text: string; latencyMs: number } | undefined;
    expect(finalMsg?.text.length).toBeGreaterThan(0);
    expect(finalMsg?.latencyMs).toBeGreaterThan(0);
  });

  it("accepts text_input and returns transcript_final immediately", async () => {
    const messages: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/audio`);

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "text_input",
            text: "What is the weather in Stockholm?",
          }),
        );
      });

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.type === "transcript_final") {
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    const finalMsg = messages.find((m) => (m as { type: string }).type === "transcript_final") as
      { text: string } | undefined;
    expect(finalMsg?.text).toContain("weather");
  });
});
