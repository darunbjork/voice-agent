import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { env } from "../../env.js";
import { costGuard } from "../../middleware/cost.guard.js";
import { handleUtterance } from "./agent.service.js";

const textBodySchema = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1, maxLength: 500 },
    sessionId: { type: "string", minLength: 1 },
    turnIndex: { type: "integer", minimum: 0 },
  },
  required: ["text", "sessionId"],
  additionalProperties: false,
} as const;

interface TextAgentBody {
  text: string;
  sessionId: string;
  turnIndex?: number;
}

export async function agentRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.post<{ Body: TextAgentBody }>(
    "/api/v1/agent/text",
    {
      preHandler: costGuard,
      schema: {
        description: "Text-only agent pipeline (same brain as voice)",
        tags: ["agent"],
        body: textBodySchema,
        response: {
          200: {
            type: "object",
            properties: {
              reply: { type: "object", additionalProperties: true },
              viaFastPath: { type: "boolean" },
              pipelineMs: { type: "number" },
              mock: { type: "boolean" },
            },
            required: ["reply", "viaFastPath", "pipelineMs", "mock"],
          },
        },
      },
    },
    async (request) => {
      const body = request.body;
      const { reply, viaFastPath, pipelineMs } = await handleUtterance(
        {
          text: body.text,
          sessionId: body.sessionId,
          turnIndex: body.turnIndex ?? 0,
          sttLatencyMs: 0,
        },
        request.log,
      );

      return { reply, viaFastPath, pipelineMs, mock: env.VOICE_MOCK };
    },
  );
}
