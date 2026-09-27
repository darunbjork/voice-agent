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

type Case = {
  text: string;
  intent: string;
  expectedCard: string | null;
  fast: boolean;
};

const CASES: Case[] = [
  {
    text: "What is the weather in Stockholm?",
    intent: "weather",
    expectedCard: "weather",
    fast: true,
  },
  {
    text: "Remind me to call the recruiter tomorrow",
    intent: "reminder",
    expectedCard: "reminder",
    fast: true,
  },
  {
    text: "Translate hello world in swedish",
    intent: "translate",
    expectedCard: "translate",
    fast: true,
  },
  {
    text: "Summarize: we shipped the API and fixed the tests.",
    intent: "summarize",
    expectedCard: "summary",
    fast: true,
  },
  {
    text: "What can you do?",
    intent: "help",
    expectedCard: "help",
    fast: true,
  },
  {
    text: "Tell me a joke about otters",
    intent: "fallback",
    expectedCard: null,
    fast: false,
  },
];

describe("agent pipeline (mock)", () => {
  for (const c of CASES) {
    it(`handles "${c.text.slice(0, 40)}" as ${c.intent} under 1000 ms`, async () => {
      const start = Date.now();
      const { reply, pipelineMs, viaFastPath } = await handleUtterance(
        {
          text: c.text,
          sessionId: "test-session",
          turnIndex: 0,
          sttLatencyMs: 40,
        },
        silentLogger,
      );
      const wall = Date.now() - start;

      expect(viaFastPath).toBe(c.fast);
      expect(reply.intent).toBe(c.intent);
      expect(reply.text.length).toBeGreaterThan(0);
      expect(reply.sessionId).toBe("test-session");
      expect(reply.latencyMs.stt).toBe(40);
      expect(pipelineMs).toBeLessThan(1000);
      expect(wall).toBeLessThan(1000);

      if (c.expectedCard === null) {
        expect(reply.card).toBeNull();
      } else {
        expect(reply.card).not.toBeNull();
        expect(reply.card?.type).toBe(c.expectedCard);
      }
    });
  }

  it("fast-path pipeline stays under 50 ms wall time (tool only, no LLM)", async () => {
    const start = Date.now();
    const { viaFastPath } = await handleUtterance(
      {
        text: "Weather in Berlin",
        sessionId: "s",
        turnIndex: 0,
        sttLatencyMs: 30,
      },
      silentLogger,
    );
    const wall = Date.now() - start;

    expect(viaFastPath).toBe(true);
    expect(wall).toBeLessThan(50);
  });

  it("empty input returns a fallback reply quickly", async () => {
    const { reply, pipelineMs, viaFastPath } = await handleUtterance(
      {
        text: "   ",
        sessionId: "s",
        turnIndex: 0,
        sttLatencyMs: 0,
      },
      silentLogger,
    );

    expect(viaFastPath).toBe(false);
    expect(reply.intent).toBe("fallback");
    expect(pipelineMs).toBeLessThan(50);
  });
});
