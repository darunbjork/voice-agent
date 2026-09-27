import type { FastifyInstance } from "fastify";
import { getDailyUsage } from "../../utils/usage-tracker.js";
import { getAllCircuitSnapshots } from "../../utils/circuit-breaker.js";
import { DAILY_MAX_TOKENS } from "../../utils/token-budget.js";

export type SessionListItem = {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  turnCount: number;
  totalTokens: number;
  language: string;
};

export type ListSessionsResult = {
  sessions: SessionListItem[];
  total: number;
};

export async function listSessions(
  app: FastifyInstance,
  opts: { limit?: number; offset?: number } = {},
): Promise<ListSessionsResult> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;

  const [sessions, total] = await Promise.all([
    app.prisma.voiceSession.findMany({
      orderBy: { startedAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        startedAt: true,
        endedAt: true,
        turnCount: true,
        totalTokens: true,
        language: true,
      },
    }),
    app.prisma.voiceSession.count(),
  ]);

  return { sessions, total };
}

export async function getSessionWithTurns(app: FastifyInstance, sessionId: string) {
  return app.prisma.voiceSession.findUnique({
    where: { id: sessionId },
    include: { turns: { orderBy: { turnIndex: "asc" } } },
  });
}

export type UsageSummary = {
  usage: {
    date: string;
    tokens: number;
    ttsChars: number;
    sttSeconds: number;
  };
  dailyMaxTokens: number;
  usagePercent: number;
  circuits: ReturnType<typeof getAllCircuitSnapshots>;
};

export async function getUsageSummary(app: FastifyInstance): Promise<UsageSummary> {
  const usage = await getDailyUsage();
  const circuits = getAllCircuitSnapshots();
  const pct = DAILY_MAX_TOKENS > 0 ? Math.round((usage.tokens / DAILY_MAX_TOKENS) * 100) : 0;

  app.log.debug({ usage, circuits }, "admin usage summary");

  return {
    usage,
    dailyMaxTokens: DAILY_MAX_TOKENS,
    usagePercent: pct,
    circuits,
  };
}
