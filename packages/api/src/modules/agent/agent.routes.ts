import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { env } from "../../env.js";
import { costGuard } from "../../middleware/cost.guard.js";
import {
  assertWithinBudget,
  estimateTokens,
  BudgetExceededError,
} from "../../utils/token-budget.js";
import { mockAgentReply } from "../../utils/voice-mock.js";
import { incrementUsage } from "../../utils/usage-tracker.js";
import type { AgentReply, IntentType } from "@voice-agent/shared-types";

interface TextAgentBody {
  text: string;
  sessionId: string;
}

interface TextAgentResponse {
  reply: AgentReply;
  mock: boolean;
}

const textBodySchema = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1, maxLength: 500 },
    sessionId: { type: "string", minLength: 1 },
  },
  required: ["text", "sessionId"],
  additionalProperties: false,
} as const;

export async function agentRoutes(
  app: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  app.post<{ Body: TextAgentBody }>(
    "/api/v1/agent/text",
    {
      preHandler: costGuard,
      schema: {
        description: "Text-only agent call (mock only on Day 4)",
        tags: ["agent"],
        body: textBodySchema,
        response: {
          200: {
            type: "object",
            properties: {
              reply: { type: "object", additionalProperties: true },
              mock: { type: "boolean" },
            },
            required: ["reply", "mock"],
          },
          429: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request): Promise<TextAgentResponse> => {
      const { text, sessionId } = request.body;

      const estimated = estimateTokens(text) + 150;
      assertWithinBudget("agent_response", estimated);

      const lower = text.toLowerCase();
      const intent: IntentType = lower.includes("weather")
        ? "weather"
        : lower.includes("help")
          ? "help"
          : "fallback";

      const reply = mockAgentReply(sessionId, 1, intent);
      await incrementUsage({ tokens: estimated });

      return { reply, mock: env.VOICE_MOCK };
    },
  );
}
