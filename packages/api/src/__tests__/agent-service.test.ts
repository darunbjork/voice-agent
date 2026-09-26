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
  it("returns a weather reply with location in the text", async () => {
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
    expect(reply.sessionId).toBe("sess-1");
    expect(reply.turnIndex).toBe(1);
    expect(reply.latencyMs.stt).toBe(42);
    expect(reply.latencyMs.total).toBeGreaterThanOrEqual(42);
  });

  it("returns a fallback reply for unknown phrases", async () => {
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
    expect(reply.text).toContain("joke about otters");
  });

  it("returns a translate reply even without extracted slots", async () => {
    const { reply } = await handleUtterance(
      {
        text: "Translate something please",
        sessionId: "sess-3",
        turnIndex: 1,
        sttLatencyMs: 20,
      },
      silentLogger,
    );

    expect(reply.intent).toBe("translate");
    expect(reply.text).not.toMatch(/\?$/);
  });
});
