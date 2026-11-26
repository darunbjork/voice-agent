// C0 — live bug: after ~20 turns every reply was "I am over my daily limit"
// although only 20 990 of 50 000 daily tokens were used. The per-call check
// (agent_response, 1500 tokens) counted system prompt + up to 3000 chars of
// history, which no longer fit. History is now trimmed (oldest first) to fit
// the per-call budget; only system prompt + the utterance itself can refuse,
// and each refusal names its real cause.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { SessionContextTurn } from "../modules/session/session.service.js";

const { generateLlmMock } = vi.hoisted(() => ({ generateLlmMock: vi.fn() }));
vi.mock("../modules/agent/llm.call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/agent/llm.call.js")>();
  return {
    ...actual,
    generateLlm: (...args: Parameters<typeof actual.generateLlm>) =>
      generateLlmMock.getMockImplementation()
        ? (generateLlmMock(...args) as ReturnType<typeof actual.generateLlm>)
        : actual.generateLlm(...args),
  };
});

import {
  buildPromptWithContext,
  handleUtterance,
  MAX_INPUT_CHARS,
} from "../modules/agent/agent.service.js";
import {
  agentPromptTokens,
  safeGenerateAgentOutput,
  SYSTEM_PROMPT,
} from "../modules/agent/gemini.service.js";
import { withCurrentDate } from "../modules/agent/gemini.tools.js";
import { BudgetExceededError, TOKEN_BUDGETS } from "../utils/token-budget.js";
import { env } from "../env.js";

const warn = vi.fn();
const log = {
  info: () => undefined,
  debug: () => undefined,
  warn,
  error: () => undefined,
  child: () => log,
} as unknown as FastifyBaseLogger;

const saved = { voiceMock: env.VOICE_MOCK, gemini: env.GEMINI_API_KEY };

beforeEach(() => {
  warn.mockClear();
  generateLlmMock.mockReset();
});
afterEach(() => {
  env.VOICE_MOCK = saved.voiceMock;
  env.GEMINI_API_KEY = saved.gemini;
});

const fitsPerCallBudget = (prompt: string) =>
  agentPromptTokens(withCurrentDate(SYSTEM_PROMPT), prompt) <= TOKEN_BUDGETS.agent_response;

/** A long spoken answer, as live (3 sentences, ~550 chars). */
const longReply = (n: number) =>
  `Answer ${n}: ` +
  "Agentic AI systems plan, call tools and check their own results before replying, ".repeat(6);

/** The 6 most recent turns, as getRecentContext gives them, before turn `n`. */
function recentContext(n: number): SessionContextTurn[] {
  const turns: SessionContextTurn[] = [];
  for (let i = Math.max(0, n - 6); i < n; i++) {
    turns.push({ role: "user", text: `Question ${i}: tell me more about agentic AI, part ${i}` });
    turns.push({ role: "agent", text: longReply(i), intent: "general" });
  }
  return turns;
}

const REFUSALS = /daily limit|too long|budget/i;

describe("a long session never refuses because of history", () => {
  it("40 slow-path turns with long replies: no refusal, every prompt fits", async () => {
    const prompts: string[] = [];
    for (let n = 0; n < 40; n++) {
      const { reply } = await handleUtterance(
        {
          text: `Question ${n}: and how does that compare with RAG, in your view?`,
          sessionId: "c0-long",
          turnIndex: n,
          sttLatencyMs: 0,
          context: recentContext(n),
        },
        log,
      );
      expect(reply.text, `turn ${n}`).not.toMatch(REFUSALS);
      const prompt = buildPromptWithContext(
        `Question ${n}: and how does that compare with RAG, in your view?`,
        recentContext(n),
      );
      prompts.push(prompt);
      expect(fitsPerCallBudget(prompt), `turn ${n} prompt fits`).toBe(true);
    }
    expect(warn.mock.calls.some(([, msg]) => /budget/i.test(String(msg)))).toBe(false);
    // Later turns still carry history (trimmed, not dropped altogether).
    expect(prompts.at(-1)).toContain("Conversation so far:");
  });
});

describe("history is trimmed oldest-first to fit the per-call budget", () => {
  const text = "And what about MCP?";
  const context = recentContext(40); // turns 34..39, ~3.6k chars

  it("keeps the newest turns, drops the oldest, keeps order", () => {
    const prompt = buildPromptWithContext(text, context);
    expect(fitsPerCallBudget(prompt)).toBe(true);
    expect(prompt).toContain("Answer 39:"); // newest kept
    expect(prompt).not.toContain("Question 34:"); // oldest dropped
    expect(prompt.indexOf("Question 38:")).toBeLessThan(prompt.indexOf("Question 39:"));
    expect(prompt.endsWith(`Current message from the user:\n${text}`)).toBe(true);
  });

  it("drops history entirely, but still answers, when only the utterance fits", () => {
    const big = "x".repeat(MAX_INPUT_CHARS);
    const prompt = buildPromptWithContext(big, context);
    expect(fitsPerCallBudget(prompt)).toBe(true);
    expect(prompt).toContain(big);
  });
});

describe("the per-call check refuses only for system prompt + utterance, with the real cause", () => {
  it("system prompt + the longest allowed utterance fit the per-call budget", () => {
    // If the system prompt grows past this, CI fails instead of users seeing refusals.
    expect(fitsPerCallBudget("x".repeat(MAX_INPUT_CHARS))).toBe(true);
  });

  it("an utterance too long on its own says so — not 'daily limit'", async () => {
    const out = await safeGenerateAgentOutput("word ".repeat(2000), log);
    expect(out.reply).toMatch(/too long/i);
    expect(out.reply).not.toMatch(/daily/i);
  });

  it("the daily cap (B2 reservation) is the only 'daily limit' message", async () => {
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "test-key";
    generateLlmMock.mockImplementation(async () => {
      throw new BudgetExceededError("daily", 50_000, 50_400);
    });
    const out = await safeGenerateAgentOutput("What is RAG?", log);
    expect(out.reply).toMatch(/daily limit/i);
  });
});
