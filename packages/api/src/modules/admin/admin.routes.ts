import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { listSessions, getSessionWithTurns, getUsageSummary } from "./admin.service.js";

interface ListQuery {
  limit?: number;
  offset?: number;
}

interface IdParams {
  id: string;
}

const sessionListItemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    startedAt: { type: "string" },
    endedAt: { type: ["string", "null"] },
    turnCount: { type: "number" },
    totalTokens: { type: "number" },
    language: { type: "string" },
  },
  required: ["id", "startedAt", "endedAt", "turnCount", "totalTokens", "language"],
  additionalProperties: false,
} as const;

const turnSchema = {
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
    createdAt: { type: "string" },
  },
  required: ["id", "sessionId", "turnIndex", "userTranscript", "agentReply", "intentType"],
  additionalProperties: true,
} as const;

export async function adminRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.get<{ Querystring: ListQuery }>(
    "/api/v1/admin/sessions",
    {
      schema: {
        description: "List recent voice sessions",
        tags: ["admin"],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            offset: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              sessions: { type: "array", items: sessionListItemSchema },
              total: { type: "number" },
            },
            required: ["sessions", "total"],
            additionalProperties: false,
          },
        },
      },
    },
    async (request) => {
      return listSessions(app, {
        limit: request.query.limit,
        offset: request.query.offset,
      });
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/admin/sessions/:id",
    {
      schema: {
        description: "Session detail with turns",
        tags: ["admin"],
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              startedAt: { type: "string" },
              endedAt: { type: ["string", "null"] },
              turnCount: { type: "number" },
              totalTokens: { type: "number" },
              language: { type: "string" },
              turns: { type: "array", items: turnSchema },
            },
            required: [
              "id",
              "startedAt",
              "endedAt",
              "turnCount",
              "totalTokens",
              "language",
              "turns",
            ],
            additionalProperties: false,
          },
          404: {
            type: "object",
            properties: { error: { type: "string" } },
            required: ["error"],
            additionalProperties: false,
          },
        },
      },
    },
    async (request, reply) => {
      const session = await getSessionWithTurns(app, request.params.id);
      if (!session) return reply.status(404).send({ error: "not_found" });
      return session;
    },
  );

  app.get(
    "/api/v1/admin/usage",
    {
      schema: {
        description: "Daily usage + circuit breaker snapshots",
        tags: ["admin"],
        response: {
          200: {
            type: "object",
            properties: {
              usage: {
                type: "object",
                properties: {
                  date: { type: "string" },
                  tokens: { type: "number" },
                  ttsChars: { type: "number" },
                  sttSeconds: { type: "number" },
                },
                required: ["date", "tokens", "ttsChars", "sttSeconds"],
                additionalProperties: false,
              },
              dailyMaxTokens: { type: "number" },
              usagePercent: { type: "number" },
              circuits: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    provider: { type: "string" },
                    state: { type: "string" },
                    failures: { type: "number" },
                    openedAt: { type: ["number", "null"] },
                    lastFailureAt: { type: ["number", "null"] },
                  },
                  required: ["provider", "state", "failures", "openedAt", "lastFailureAt"],
                  additionalProperties: false,
                },
              },
            },
            required: ["usage", "dailyMaxTokens", "usagePercent", "circuits"],
            additionalProperties: false,
          },
        },
      },
    },
    async () => getUsageSummary(app),
  );
}
