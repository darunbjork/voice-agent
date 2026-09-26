import { describe, it, expect } from "vitest";
import { handleUtterance } from "../modules/agent/agent.service.js";
import type { FastifyBaseLogger } from "fastify";

const silentLogger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger;

describe("handleUtterance", () => {
  it("fast-path weather keeps the extracted location in the reply", async () => {
    const { reply, viaFastPath } = await handleUtterance(
      {
        text: "What is the weather in Stockholm?",
        sessionId: "sess-1",
        turnIndex: 1,
        sttLatencyMs: 42,
      },
      silentLogger,
    );

    expect(viaFastPath).toBe(true);
    expect(reply.intent).toBe("weather");
    expect(reply.text.toLowerCase()).toContain("stockholm");
    expect(reply.card?.type).toBe("weather");
    expect(reply.sessionId).toBe("sess-1");
    expect(reply.latencyMs.stt).toBe(42);
    expect(reply.latencyMs.total).toBeGreaterThanOrEqual(42);
  });

  it("slow-path unknown phrases go through Gemini (mock) and return fallback", async () => {
    const { reply, viaFastPath } = await handleUtterance(
      {
        text: "Tell me a joke about otters",
        sessionId: "sess-2",
        turnIndex: 3,
        sttLatencyMs: 30,
      },
      silentLogger,
    );

    expect(viaFastPath).toBe(false);
    expect(reply.intent).toBe("fallback");
    expect(reply.card).toBeNull();
  });

  it("fast-path translate always returns a non-question reply", async () => {
    const { reply, viaFastPath } = await handleUtterance(
      {
        text: "Translate something please",
        sessionId: "sess-3",
        turnIndex: 1,
        sttLatencyMs: 20,
      },
      silentLogger,
    );

    expect(viaFastPath).toBe(true);
    expect(reply.intent).toBe("translate");
    expect(reply.text).not.toMatch(/\?$/);
  });
});
