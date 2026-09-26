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
  it("fast-path weather uses the tool card and skips Gemini", async () => {
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
    expect(reply.card?.type).toBe("weather");
    if (reply.card?.type === "weather") {
      expect(reply.card.location.toLowerCase()).toContain("stockholm");
    }
    // Tool-only path should be very fast; assert the shape, not exact ms.
    expect(reply.latencyMs.llm).toBeLessThan(50);
  });

  it("fast-path help uses the help tool", async () => {
    const { reply, viaFastPath } = await handleUtterance(
      {
        text: "What can you do?",
        sessionId: "sess-2",
        turnIndex: 1,
        sttLatencyMs: 20,
      },
      silentLogger,
    );

    expect(viaFastPath).toBe(true);
    expect(reply.intent).toBe("help");
    expect(reply.card?.type).toBe("help");
  });

  it("slow-path falls through to Gemini (mock) and returns fallback", async () => {
    const { reply, viaFastPath } = await handleUtterance(
      {
        text: "Tell me a joke about otters",
        sessionId: "sess-3",
        turnIndex: 3,
        sttLatencyMs: 30,
      },
      silentLogger,
    );

    expect(viaFastPath).toBe(false);
    expect(reply.intent).toBe("fallback");
    expect(reply.card).toBeNull();
  });
});
