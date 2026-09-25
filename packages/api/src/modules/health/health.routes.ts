// packages/api/src/modules/health/health.routes.ts
// RULE 8: Every Fastify route must have complete JSON Schema.

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { env } from "../../env.js";
import { getDailyUsage } from "../../utils/usage-tracker.js";
import { DAILY_MAX_TOKENS } from "../../utils/token-budget.js";

const healthResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "degraded", "down"] },
    db: { type: "string", enum: ["ok", "down", "not_configured"] },
    redis: { type: "string", enum: ["ok", "down", "not_configured"] },
    voiceMock: { type: "boolean" },
    dailyTokens: { type: "number" },
    dailyTokenLimit: { type: "number" },
    timestamp: { type: "string", format: "date-time" },
    correlationId: { type: "string" },
  },
  required: [
    "status",
    "db",
    "redis",
    "voiceMock",
    "dailyTokens",
    "dailyTokenLimit",
    "timestamp",
    "correlationId",
  ],
  additionalProperties: false,
} as const;

interface HealthResponse {
  status: "ok" | "degraded" | "down";
  db: "ok" | "down" | "not_configured";
  redis: "ok" | "down" | "not_configured";
  voiceMock: boolean;
  dailyTokens: number;
  dailyTokenLimit: number;
  timestamp: string;
  correlationId: string;
}

export async function healthRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        description: "Liveness + readiness + cost snapshot",
        tags: ["health"],
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async (request): Promise<HealthResponse> => {
      const db: "ok" | "not_configured" = env.DATABASE_URL ? "ok" : "not_configured";
      const redis: "ok" | "not_configured" = env.REDIS_URL ? "ok" : "not_configured";
      const usage = getDailyUsage();

      return {
        status: db === "ok" && redis === "ok" ? "ok" : "degraded",
        db,
        redis,
        voiceMock: env.VOICE_MOCK,
        dailyTokens: usage.tokens,
        dailyTokenLimit: DAILY_MAX_TOKENS,
        timestamp: new Date().toISOString(),
        correlationId: request.correlationId,
      };
    },
  );
}
