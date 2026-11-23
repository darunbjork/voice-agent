// Every JSON message a client sends on /api/ws/audio is validated with one
// Zod discriminated union (shared-types). Before, it was cast unchecked:
// `{"type":"nope"}` was silently ignored and `{"type":"text_input","text":42}`
// reached the agent.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import {
  ClientControlMessageSchema,
  TEXT_INPUT_MAX_CHARS,
} from "@voice-agent/shared-types/schemas";
import { buildApp } from "../app.js";

describe("ClientControlMessageSchema", () => {
  it.each([
    { type: "text_input", text: "What is the weather in Oslo?" },
    { type: "text_input", text: "a".repeat(TEXT_INPUT_MAX_CHARS) },
    { type: "barge_in" },
    { type: "session_end" },
  ])("accepts %j", (msg) => {
    expect(ClientControlMessageSchema.safeParse(msg).success).toBe(true);
  });

  it.each([
    ["unknown type", { type: "nope" }],
    ["no type", { text: "hi" }],
    ["text is a number", { type: "text_input", text: 42 }],
    ["text missing", { type: "text_input" }],
    ["text only whitespace", { type: "text_input", text: "   " }],
    ["text over the cap", { type: "text_input", text: "a".repeat(TEXT_INPUT_MAX_CHARS + 1) }],
    ["audio as JSON (audio is binary only)", { type: "audio_chunk", data: [1, 2, 3] }],
    ["extra keys", { type: "barge_in", admin: true }],
    ["array", [{ type: "barge_in" }]],
    ["null", null],
    ["string", "barge_in"],
  ])("rejects %s", (_label, msg) => {
    expect(ClientControlMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe("WebSocket /api/ws/audio rejects malformed messages", () => {
  let app: FastifyInstance;
  let url: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/api/ws/audio`;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Sends `frames` after session_id, then a valid text_input; collects JSON messages. */
  function session(frames: string[]): Promise<Array<{ type: string; code?: string }>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: "http://localhost:5173" } });
      const msgs: Array<{ type: string; code?: string }> = [];
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString()) as { type: string; code?: string };
        msgs.push(msg);
        if (msg.type === "session_id") {
          for (const f of frames) ws.send(f);
          ws.send(JSON.stringify({ type: "text_input", text: "still works" }));
        }
        if (msg.type === "transcript_final") {
          ws.close();
          resolve(msgs);
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error(`timed out: ${JSON.stringify(msgs)}`)), 5000);
    });
  }

  const codes = (msgs: Array<{ type: string; code?: string }>) =>
    msgs.flatMap((m) => (m.type === "error" ? [m.code] : []));

  it("answers invalid_message for each malformed frame and keeps the session usable", async () => {
    const msgs = await session([
      "{not json",
      JSON.stringify({ type: "nope" }),
      JSON.stringify({ type: "text_input", text: 42 }),
      JSON.stringify({ type: "barge_in", extra: 1 }),
    ]);
    expect(codes(msgs)).toEqual([
      "invalid_message",
      "invalid_message",
      "invalid_message",
      "invalid_message",
    ]);
    const finals = msgs.filter((m) => m.type === "transcript_final");
    expect(finals).toHaveLength(1);
  });

  it("over-long text_input keeps its specific code", async () => {
    const msgs = await session([
      JSON.stringify({ type: "text_input", text: "a".repeat(TEXT_INPUT_MAX_CHARS + 1) }),
    ]);
    expect(codes(msgs)).toEqual(["text_too_long"]);
  });
});
