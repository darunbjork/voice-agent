import type { PrismaClient } from "../../generated/prisma/index.js";
import type { AgentReply, IntentType, LatencyBreakdown } from "@voice-agent/shared-types";

export type CreateSessionResult = {
  sessionId: string;
  startedAt: Date;
};

export type AppendTurnInput = {
  sessionId: string;
  userTranscript: string;
  reply: AgentReply;
};

export type SessionContextTurn = {
  role: "user" | "agent";
  text: string;
  intent?: IntentType;
};

const CONTEXT_TURNS = 3;

export async function createSession(
  prisma: PrismaClient,
  language = "en",
): Promise<CreateSessionResult> {
  const session = await prisma.voiceSession.create({
    data: { language, turnCount: 0, totalTokens: 0 },
  });
  return { sessionId: session.id, startedAt: session.startedAt };
}

export async function getNextTurnIndex(prisma: PrismaClient, sessionId: string): Promise<number> {
  const session = await prisma.voiceSession.findUnique({
    where: { id: sessionId },
    select: { turnCount: true },
  });
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session.turnCount;
}

export async function getRecentContext(
  prisma: PrismaClient,
  sessionId: string,
  maxTurns: number = CONTEXT_TURNS,
): Promise<SessionContextTurn[]> {
  const turns = await prisma.conversationTurn.findMany({
    where: { sessionId },
    orderBy: { turnIndex: "desc" },
    take: maxTurns,
  });

  const chronological = turns.reverse();
  const context: SessionContextTurn[] = [];

  for (const t of chronological) {
    context.push({ role: "user", text: t.userTranscript });
    context.push({
      role: "agent",
      text: t.agentReply,
      intent: t.intentType as IntentType,
    });
  }

  return context;
}

export async function appendTurn(
  prisma: PrismaClient,
  input: AppendTurnInput,
  turnIndex: number,
): Promise<void> {
  const { sessionId, userTranscript, reply } = input;
  const latency: LatencyBreakdown = reply.latencyMs;
  const tokens = estimateTurnTokens(userTranscript, reply.text);

  await prisma.$transaction([
    prisma.conversationTurn.create({
      data: {
        sessionId,
        turnIndex,
        userTranscript,
        agentReply: reply.text,
        intentType: reply.intent,
        cardType: reply.card?.type ?? null,
        sttLatencyMs: latency.stt,
        llmLatencyMs: latency.llm,
        ttsLatencyMs: latency.tts,
        totalLatencyMs: latency.total,
        tokenCount: tokens,
      },
    }),
    prisma.voiceSession.update({
      where: { id: sessionId },
      data: {
        turnCount: { increment: 1 },
        totalTokens: { increment: tokens },
      },
    }),
  ]);
}

export async function endSession(prisma: PrismaClient, sessionId: string): Promise<void> {
  await prisma.voiceSession.update({
    where: { id: sessionId },
    data: { endedAt: new Date() },
  });
}

export async function getSessionDetail(prisma: PrismaClient, sessionId: string) {
  return prisma.voiceSession.findUnique({
    where: { id: sessionId },
    include: { turns: { orderBy: { turnIndex: "asc" } } },
  });
}

function estimateTurnTokens(user: string, agent: string): number {
  return Math.ceil(user.length / 4) + Math.ceil(agent.length / 4) + 40;
}
