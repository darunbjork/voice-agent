import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import { env } from "../env.js";
import { buildApp } from "../app.js";
import { costGuard, checkDailyTokenBudget } from "../middleware/cost.guard.js";
import { incrementUsage, resetUsageMemory } from "../utils/usage-tracker.js";

const savedCap = env.DAILY_MAX_TOKENS;

function fakeReply() {
  const sent: { status?: number; headers: Record<string, string>; body?: unknown } = {
    headers: {},
  };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    header(k: string, v: string) {
      sent.headers[k] = v;
      return reply;
    },
    async send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

const req = (text: string) => ({ body: { text } }) as unknown as FastifyRequest;

describe("daily token guard (unit)", () => {
  beforeEach(() => resetUsageMemory());
  afterEach(() => {
    env.DAILY_MAX_TOKENS = savedCap;
    resetUsageMemory();
  });

  it("lets a turn through while under the ceiling", async () => {
    env.DAILY_MAX_TOKENS = 1000;
    expect(await checkDailyTokenBudget("hello")).toBeNull();
    const { reply, sent } = fakeReply();
    await costGuard(req("hello"), reply);
    expect(sent.status).toBeUndefined();
  });

  it("blocks when this turn's estimate would cross the ceiling (assertDailyBudget)", async () => {
    env.DAILY_MAX_TOKENS = 1000;
    await incrementUsage({ tokens: 998 });
    // "a".repeat(40) ≈ 10 tokens → 1008 > 1000
    const exceeded = await checkDailyTokenBudget("a".repeat(40));
    expect(exceeded?.error.limit).toBe(1000);
    expect(exceeded?.currentTokens).toBe(998);
  });

  it("blocks once usage has reached the ceiling, even for an empty body", async () => {
    env.DAILY_MAX_TOKENS = 1000;
    await incrementUsage({ tokens: 1000 });
    const { reply, sent } = fakeReply();
    await costGuard({ body: undefined } as unknown as FastifyRequest, reply);
    expect(sent.status).toBe(429);
    expect(sent.headers["Retry-After"]).toBe("3600");
    expect(sent.body).toMatchObject({ error: "budget_exceeded", limit: 1000, current: 1000 });
  });
});

// Route-level checks need Postgres (buildApp registers Prisma), like agent-text/audio-ws.
describe("daily token guard on both entry points", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    env.DAILY_MAX_TOKENS = savedCap;
    await app?.close();
  });

  afterEach(() => {
    env.DAILY_MAX_TOKENS = savedCap;
  });

  it("HTTP /api/v1/agent/text returns 429 budget_exceeded over the ceiling", async () => {
    env.DAILY_MAX_TOKENS = 1;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/text",
      headers: { "content-type": "application/json" },
      payload: { text: "What is the weather in Stockholm?", sessionId: "budget-http" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "budget_exceeded" });
  });

  it("WebSocket text_input gets budget_exceeded and no agent_response over the ceiling", async () => {
    env.DAILY_MAX_TOKENS = 1;
    const messages: Array<{ type: string; code?: string }> = [];

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/audio`);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "text_input", text: "What is the weather in Stockholm?" }));
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString()) as { type: string; code?: string };
        messages.push(msg);
        if (msg.type === "error" && msg.code === "budget_exceeded") {
          setTimeout(() => {
            ws.close();
            resolve();
          }, 100);
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 4000);
    });

    expect(messages.some((m) => m.type === "agent_response")).toBe(false);
    expect(messages.some((m) => m.type === "agent_thinking")).toBe(true);
  });
});
