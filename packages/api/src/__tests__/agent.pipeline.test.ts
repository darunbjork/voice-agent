import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { safeGenerateAgentOutput } from "../modules/agent/gemini.service.js";
import type { FastifyBaseLogger } from "fastify";

// Pass-through spy: real behaviour, but lets us assert whether the LLM ran
// (instead of timing the turn, which flaked on slow CI runners).
vi.mock("../modules/agent/gemini.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/agent/gemini.service.js")>();
  return { ...actual, safeGenerateAgentOutput: vi.fn(actual.safeGenerateAgentOutput) };
});

beforeEach(() => {
  vi.mocked(safeGenerateAgentOutput).mockClear();
});

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
    it(`handles "${c.text.slice(0, 40)}" as ${c.intent}`, async () => {
      const { reply, viaFastPath } = await handleUtterance(
        {
          text: c.text,
          sessionId: "test-session",
          turnIndex: 0,
          sttLatencyMs: 40,
        },
        silentLogger,
      );
      expect(viaFastPath).toBe(c.fast);
      expect(reply.intent).toBe(c.intent);
      expect(reply.text.length).toBeGreaterThan(0);
      expect(reply.sessionId).toBe("test-session");
      expect(reply.latencyMs.stt).toBe(40);
      // Fast path = tools only; slow path = exactly one LLM call (no timing).
      expect(safeGenerateAgentOutput).toHaveBeenCalledTimes(c.fast ? 0 : 1);

      if (c.expectedCard === null) {
        expect(reply.card).toBeNull();
      } else {
        expect(reply.card).not.toBeNull();
        expect(reply.card?.type).toBe(c.expectedCard);
      }
    });
  }

  it("fast-path pipeline is tool only: the LLM is not called", async () => {
    const { viaFastPath } = await handleUtterance(
      {
        text: "Weather in Berlin",
        sessionId: "s",
        turnIndex: 0,
        sttLatencyMs: 30,
      },
      silentLogger,
    );
    expect(viaFastPath).toBe(true);
    expect(safeGenerateAgentOutput).not.toHaveBeenCalled();
  });

  it("empty input returns a fallback reply without calling the LLM", async () => {
    const { reply, viaFastPath } = await handleUtterance(
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
    expect(safeGenerateAgentOutput).not.toHaveBeenCalled();
  });
});
