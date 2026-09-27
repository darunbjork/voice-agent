import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { env } from "../../env.js";
import { getDailyUsage } from "../../utils/usage-tracker.js";
import { getAllCircuitSnapshots, type CircuitSnapshot } from "../../utils/circuit-breaker.js";
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
    circuits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: ["gemini", "deepgram", "elevenlabs"],
          },
          state: { type: "string", enum: ["closed", "open", "half_open"] },
          failures: { type: "number" },
          openedAt: { type: ["number", "null"] },
          lastFailureAt: { type: ["number", "null"] },
        },
        required: ["provider", "state", "failures", "openedAt", "lastFailureAt"],
        additionalProperties: false,
      },
    },
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
    "circuits",
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
  circuits: CircuitSnapshot[];
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
        response: { 200: healthResponseSchema },
      },
    },
    async (request): Promise<HealthResponse> => {
      let db: HealthResponse["db"] = "not_configured";
      let redis: HealthResponse["redis"] = "not_configured";

      try {
        await app.prisma.$queryRaw`SELECT 1`;
        db = "ok";
      } catch {
        db = "down";
      }

      if (app.redis !== undefined) {
        try {
          const pong = await app.redis.ping();
          redis = pong === "PONG" ? "ok" : "down";
        } catch {
          redis = "down";
        }
      }

      const usage = await getDailyUsage();

      const status: HealthResponse["status"] =
        db === "ok" && redis === "ok"
          ? "ok"
          : db === "down" || redis === "down"
            ? "down"
            : "degraded";

      return {
        status,
        db,
        redis,
        voiceMock: env.VOICE_MOCK,
        dailyTokens: usage.tokens,
        dailyTokenLimit: DAILY_MAX_TOKENS,
        circuits: getAllCircuitSnapshots(),
        timestamp: new Date().toISOString(),
        correlationId: request.correlationId,
      };
    },
  );
}
