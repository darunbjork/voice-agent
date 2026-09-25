import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { env } from "../../env.js";

const healthResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "degraded", "down"] },
    db: { type: "string", enum: ["ok", "down", "not_configured"] },
    redis: { type: "string", enum: ["ok", "down", "not_configured"] },
    voiceMock: { type: "boolean" },
    timestamp: { type: "string", format: "date-time" },
    correlationId: { type: "string" },
  },
  required: ["status", "db", "redis", "voiceMock", "timestamp", "correlationId"],
  additionalProperties: false,
} as const;

export async function healthRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        description: "Liveness + readiness probe for the Voice Agent API",
        tags: ["health"],
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async (request): Promise<{
      status: "ok" | "degraded" | "down";
      db: "ok" | "down" | "not_configured";
      redis: "ok" | "down" | "not_configured";
      voiceMock: boolean;
      timestamp: string;
      correlationId: string;
    }> => {
      const dbStatus: "ok" | "not_configured" = env.DATABASE_URL ? "ok" : "not_configured";
      const redisStatus: "ok" | "not_configured" = env.REDIS_URL ? "ok" : "not_configured";

      const overall: "ok" | "degraded" | "down" =
        dbStatus === "ok" && redisStatus === "ok" ? "ok" : "degraded";

      return {
        status: overall,
        db: dbStatus,
        redis: redisStatus,
        voiceMock: env.VOICE_MOCK,
        timestamp: new Date().toISOString(),
        correlationId: request.correlationId,
      };
    },
  );
}
