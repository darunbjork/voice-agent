import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

describe("GET /health", () => {
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns 200 and the expected shape", async () => {
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toMatchObject({
      status: expect.stringMatching(/ok|degraded|down/),
      db: expect.stringMatching(/ok|down|not_configured/),
      redis: expect.stringMatching(/ok|down|not_configured/),
      voiceMock: true,
      dailyTokenLimit: 50_000,
    });
    expect(typeof body.dailyTokens).toBe("number");
    expect(typeof body.correlationId).toBe("string");
    expect(body.correlationId.length).toBeGreaterThan(0);
    expect(body.circuits).toHaveLength(3);
    expect(body.circuits[0]).toEqual({
      provider: "gemini",
      state: "closed",
      failures: 0,
      openedAt: null,
      lastFailureAt: null,
    });
  });
});
