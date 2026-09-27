import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import {
  createSession,
  appendTurn,
  getRecentContext,
  getNextTurnIndex,
  endSession,
  getSessionDetail,
} from "../modules/session/session.service.js";
import type { AgentReply } from "@voice-agent/shared-types";

function makeReply(text: string, intent: AgentReply["intent"], sessionId: string): AgentReply {
  return {
    text,
    intent,
    card: null,
    latencyMs: { stt: 10, llm: 20, tts: 0, total: 30 },
    sessionId,
    turnIndex: 0,
  };
}

describe("session.service", () => {
  let app: FastifyInstance;
  let sessionId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const created = await createSession(app.prisma);
    sessionId = created.sessionId;
  });

  afterAll(async () => {
    await app.close();
  });

  it("starts with turnCount 0", async () => {
    const next = await getNextTurnIndex(app.prisma, sessionId);
    expect(next).toBe(0);
  });

  it("appends turns with incrementing indices", async () => {
    const r1 = makeReply("Checking weather for Stockholm.", "weather", sessionId);
    await appendTurn(
      app.prisma,
      { sessionId, userTranscript: "Weather in Stockholm?", reply: r1 },
      0,
    );

    const nextAfterFirst = await getNextTurnIndex(app.prisma, sessionId);
    expect(nextAfterFirst).toBe(1);

    const r2 = makeReply("Okay, I will remind you.", "reminder", sessionId);
    await appendTurn(
      app.prisma,
      { sessionId, userTranscript: "Remind me about that trip", reply: r2 },
      1,
    );

    const nextAfterSecond = await getNextTurnIndex(app.prisma, sessionId);
    expect(nextAfterSecond).toBe(2);
  });

  it("returns recent context with both roles", async () => {
    const ctx = await getRecentContext(app.prisma, sessionId);
    expect(ctx.length).toBeGreaterThanOrEqual(2);
    expect(ctx.some((c) => c.role === "user")).toBe(true);
    expect(ctx.some((c) => c.role === "agent")).toBe(true);
    const userTexts = ctx.filter((c) => c.role === "user").map((c) => c.text);
    expect(userTexts.some((t) => /weather|stockholm/i.test(t))).toBe(true);
  });

  it("loads session detail with turns", async () => {
    const detail = await getSessionDetail(app.prisma, sessionId);
    if (!detail) throw new Error("session missing");
    expect(detail.turnCount).toBeGreaterThanOrEqual(2);
    expect(detail.turns.length).toBeGreaterThanOrEqual(2);
    expect(detail.turns[0]?.turnIndex).toBe(0);
    expect(detail.turns[1]?.turnIndex).toBe(1);
  });

  it("ends the session", async () => {
    await endSession(app.prisma, sessionId);
    const detail = await getSessionDetail(app.prisma, sessionId);
    if (!detail) throw new Error("session missing");
    expect(detail.endedAt).not.toBeNull();
  });
});
