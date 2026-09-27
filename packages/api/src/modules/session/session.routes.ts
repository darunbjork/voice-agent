import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from "fastify";
import { createSession, endSession, getSessionDetail } from "./session.service.js";

interface CreateBody {
  language?: string;
}

interface IdParams {
  id: string;
}

type SessionTurnResponse = {
  id: string;
  sessionId: string;
  turnIndex: number;
  userTranscript: string;
  agentReply: string;
  intentType: string;
  cardType: string | null;
  sttLatencyMs: number | null;
  llmLatencyMs: number | null;
  ttsLatencyMs: number | null;
  totalLatencyMs: number | null;
  tokenCount: number;
  createdAt: string;
};

type SessionDetailResponse = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  totalTokens: number;
  language: string;
  turns: SessionTurnResponse[];
};

type CreateSessionResponse = {
  sessionId: string;
  startedAt: string;
};

const notFoundSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
  additionalProperties: false,
} as const;

const sessionTurnSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionId: { type: "string" },
    turnIndex: { type: "number" },
    userTranscript: { type: "string" },
    agentReply: { type: "string" },
    intentType: { type: "string" },
    cardType: { type: ["string", "null"] },
    sttLatencyMs: { type: ["number", "null"] },
    llmLatencyMs: { type: ["number", "null"] },
    ttsLatencyMs: { type: ["number", "null"] },
    totalLatencyMs: { type: ["number", "null"] },
    tokenCount: { type: "number" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "sessionId",
    "turnIndex",
    "userTranscript",
    "agentReply",
    "intentType",
    "cardType",
    "sttLatencyMs",
    "llmLatencyMs",
    "ttsLatencyMs",
    "totalLatencyMs",
    "tokenCount",
    "createdAt",
  ],
  additionalProperties: false,
} as const;

const sessionDetailSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    startedAt: { type: "string", format: "date-time" },
    endedAt: { type: ["string", "null"] },
    turnCount: { type: "number" },
    totalTokens: { type: "number" },
    language: { type: "string" },
    turns: { type: "array", items: sessionTurnSchema },
  },
  required: ["id", "startedAt", "endedAt", "turnCount", "totalTokens", "language", "turns"],
  additionalProperties: false,
} as const;

const idParamsSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
} as const;

export async function sessionRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.post<{ Body: CreateBody }>(
    "/api/v1/sessions",
    {
      schema: {
        description: "Start a new voice session",
        tags: ["sessions"],
        body: {
          type: "object",
          properties: { language: { type: "string" } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              startedAt: { type: "string", format: "date-time" },
            },
            required: ["sessionId", "startedAt"],
            additionalProperties: false,
          },
        },
      },
    },
    async (request): Promise<CreateSessionResponse> => {
      const language = request.body?.language ?? "en";
      const result = await createSession(app.prisma, language);
      return {
        sessionId: result.sessionId,
        startedAt: result.startedAt.toISOString(),
      };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/sessions/:id",
    {
      schema: {
        description: "Get session detail with turns",
        tags: ["sessions"],
        params: idParamsSchema,
        response: {
          200: sessionDetailSchema,
          404: notFoundSchema,
        },
      },
    },
    async (request, reply): Promise<SessionDetailResponse | FastifyReply> => {
      const detail = await getSessionDetail(app.prisma, request.params.id);
      if (!detail) return reply.status(404).send({ error: "not_found" });

      return {
        id: detail.id,
        startedAt: detail.startedAt.toISOString(),
        endedAt: detail.endedAt === null ? null : detail.endedAt.toISOString(),
        turnCount: detail.turnCount,
        totalTokens: detail.totalTokens,
        language: detail.language,
        turns: detail.turns.map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          turnIndex: t.turnIndex,
          userTranscript: t.userTranscript,
          agentReply: t.agentReply,
          intentType: t.intentType,
          cardType: t.cardType,
          sttLatencyMs: t.sttLatencyMs,
          llmLatencyMs: t.llmLatencyMs,
          ttsLatencyMs: t.ttsLatencyMs,
          totalLatencyMs: t.totalLatencyMs,
          tokenCount: t.tokenCount,
          createdAt: t.createdAt.toISOString(),
        })),
      };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/api/v1/sessions/:id",
    {
      schema: {
        description: "End a voice session",
        tags: ["sessions"],
        params: idParamsSchema,
        response: {
          200: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          404: notFoundSchema,
        },
      },
    },
    async (request, reply): Promise<{ ok: boolean } | FastifyReply> => {
      try {
        await endSession(app.prisma, request.params.id);
        return { ok: true };
      } catch {
        return reply.status(404).send({ error: "not_found" });
      }
    },
  );
}
