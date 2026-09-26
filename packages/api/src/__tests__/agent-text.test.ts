import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

describe("POST /api/v1/agent/text", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns a mock weather reply when VOICE_MOCK=true", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/text",
      headers: { "content-type": "application/json" },
      payload: {
        text: "What is the weather in Stockholm?",
        sessionId: "test-session-ci",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mock).toBe(true);
    expect(body.reply.intent).toBe("weather");
    expect(body.reply.card.type).toBe("weather");
    expect(body.reply.text.length).toBeGreaterThan(0);
    expect(body.reply.latencyMs.total).toBeGreaterThan(0);
  });

  it("returns help intent for help-like text", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/text",
      headers: { "content-type": "application/json" },
      payload: { text: "help me", sessionId: "test-session-ci-2" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().reply.intent).toBe("help");
  });

  it("rejects empty text with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/text",
      headers: { "content-type": "application/json" },
      payload: { text: "", sessionId: "test-session-ci-3" },
    });
    expect(response.statusCode).toBe(400);
  });
});