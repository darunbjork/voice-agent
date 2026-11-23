// Token reservations (llm.call.ts) go through the Redis-backed usage tracker,
// so machines share one daily cap. Each "machine" here is a fresh copy of the
// modules (own in-memory state, own Redis connection), like two Fly machines.
// Runs against the local Redis from docker compose / CI; skipped without REDIS_URL.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { estimateTokens } from "../utils/token-budget.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

const REDIS_URL = process.env.REDIS_URL;
const request = { system: "You are terse.", user: "What is two plus two?", temperature: 0 };

type Machine = {
  generateLlm: typeof import("../modules/agent/llm.call.js").generateLlm;
  BudgetExceededError: typeof import("../utils/token-budget.js").BudgetExceededError;
  getDailyUsage: typeof import("../utils/usage-tracker.js").getDailyUsage;
  reservation: number;
  close: () => Promise<void>;
};

const savedEnv = { ...process.env };
let prefix = "";
const machines: Machine[] = [];

/** A fresh module graph = a separate process, bound to Redis (or not). */
async function machine(withRedis: boolean): Promise<Machine> {
  vi.resetModules();
  const llm = await import("../modules/agent/llm.call.js");
  const budget = await import("../utils/token-budget.js");
  const tracker = await import("../utils/usage-tracker.js");
  let client: ReturnType<typeof createClient> | null = null;
  if (withRedis) {
    client = createClient({ url: REDIS_URL });
    await client.connect();
    tracker.bindRedis(client, { keyPrefix: prefix });
  }
  const m: Machine = {
    generateLlm: llm.generateLlm,
    BudgetExceededError: budget.BudgetExceededError,
    getDailyUsage: tracker.getDailyUsage,
    reservation:
      estimateTokens(request.system) + estimateTokens(request.user) + llm.LLM_RESERVE_REPLY_TOKENS,
    close: async () => {
      tracker.unbindRedis();
      if (client) {
        const keys = await client.keys(`${prefix}:*`);
        if (keys.length > 0) await client.del(keys);
        await client.quit();
      }
    },
  };
  machines.push(m);
  return m;
}

/** Two concurrent LLM calls on each machine; counts successes and budget refusals. */
async function twoCallsEach(a: Machine, b: Machine) {
  const calls = [a, a, b, b].map((m) => m.generateLlm(request));
  const outcomes = await Promise.allSettled(calls);
  return {
    ok: outcomes.filter((o) => o.status === "fulfilled").length,
    refused: outcomes.filter(
      (o, i) => o.status === "rejected" && o.reason instanceof [a, a, b, b][i]!.BudgetExceededError,
    ).length,
  };
}

describe.skipIf(!REDIS_URL)("token reservations across machines", () => {
  beforeEach(async () => {
    prefix = `test:${randomUUID()}`;
    generateContentMock.mockReset();
    generateContentMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      // Report exactly the reservation, so settlement does not free room.
      return { text: "Four.", candidates: [{ finishReason: "STOP" }], usageMetadata: {} };
    });
    // Fresh modules read env from process.env.
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_FALLBACK_MODEL = "";
    process.env.GROQ_API_KEY = "";
  });

  afterEach(async () => {
    await Promise.all(machines.splice(0).map((m) => m.close()));
    process.env = { ...savedEnv };
    vi.resetModules();
  });

  it("with Redis: room for 2, 4 concurrent calls on 2 machines → exactly 2 succeed", async () => {
    const probe = await machine(false);
    process.env.DAILY_MAX_TOKENS = String(probe.reservation * 2);
    machines.splice(machines.indexOf(probe), 1);

    const a = await machine(true);
    const b = await machine(true);
    generateContentMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return {
        text: "Four.",
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { totalTokenCount: a.reservation },
      };
    });

    const { ok, refused } = await twoCallsEach(a, b);
    expect(ok).toBe(2);
    expect(refused).toBe(2);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    // Both machines see the same shared total, within the cap.
    expect((await a.getDailyUsage()).tokens).toBe(a.reservation * 2);
    expect((await b.getDailyUsage()).tokens).toBe(a.reservation * 2);
  });

  it("without Redis each machine has its own cap, so all 4 calls succeed", async () => {
    const probe = await machine(false);
    process.env.DAILY_MAX_TOKENS = String(probe.reservation * 2);
    machines.splice(machines.indexOf(probe), 1);

    const a = await machine(false);
    const b = await machine(false);
    generateContentMock.mockImplementation(async () => ({
      text: "Four.",
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { totalTokenCount: a.reservation },
    }));

    const { ok } = await twoCallsEach(a, b);
    expect(ok).toBe(4);
  });
});
