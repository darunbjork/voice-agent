import { describe, it, expect } from "vitest";
import { generateAgentOutput, safeGenerateAgentOutput } from "../modules/agent/gemini.service.js";
import { GeminiAgentOutputSchema } from "../modules/agent/gemini.schema.js";
import type { FastifyBaseLogger } from "fastify";

const silentLogger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger;

describe("gemini.service (VOICE_MOCK=true)", () => {
  it("returns a Zod-valid weather payload", async () => {
    const out = await generateAgentOutput(
      "What is the weather in Stockholm?",
      silentLogger,
      "weather",
    );
    const parsed = GeminiAgentOutputSchema.safeParse(out);
    expect(parsed.success).toBe(true);
    expect(out.intent).toBe("weather");
    expect(out.card?.type).toBe("weather");
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it("returns a Zod-valid help payload", async () => {
    const out = await generateAgentOutput("help", silentLogger, "help");
    const parsed = GeminiAgentOutputSchema.safeParse(out);
    expect(parsed.success).toBe(true);
    expect(out.intent).toBe("help");
    expect(out.card?.type).toBe("help");
  });

  it("defaults to fallback with a null card when no intent is given", async () => {
    const out = await generateAgentOutput("something obscure", silentLogger);
    expect(out.intent).toBe("fallback");
    expect(out.card).toBeNull();
  });

  it("safeGenerateAgentOutput never throws", async () => {
    const out = await safeGenerateAgentOutput("something obscure", silentLogger);
    expect(out.reply).toBeTruthy();
    expect(out.intent).toBeDefined();
  });
});
