import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env, envSchema } from "../env.js";
import {
  SYSTEM_PROMPT,
  AGENT_TEMPERATURE,
  safeGenerateAgentOutput,
} from "../modules/agent/gemini.service.js";
import {
  buildPromptWithContext,
  handleUtterance,
  MAX_CONTEXT_CHARS,
} from "../modules/agent/agent.service.js";
import { GROQ_BASE_URL } from "../modules/agent/groq.client.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

type LogCall = [Record<string, unknown>, string];
function recordingLogger() {
  const info: LogCall[] = [];
  const log = {
    info: (o: Record<string, unknown>, m: string) => info.push([o, m]),
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => log,
  };
  return { log: log as unknown as FastifyBaseLogger, info };
}

const agentJson = (reply: string) => JSON.stringify({ reply, intent: "general", card: null });
const geminiOk = (text: string) => ({ text, candidates: [{ finishReason: "STOP" }] });
const geminiDown = () =>
  Object.assign(new Error('{"error":{"code":503,"message":"high demand"}}'), { status: 503 });

describe("general-answer rules in the prompt", () => {
  it.each([
    [/If you are not sure, say "I'm not sure"/],
    [/Never invent products, models, companies, acronym expansions, laws, regulations, places/],
    [/Resolve acronyms and short names from the conversation so far first/],
    [/looks like a transcription error .* ask "Did you mean …\?"/],
    [
      /You cannot control the microphone, the speaker, other apps, websites, files or device settings/,
    ],
    [/Never claim you did any of these/],
    [/unfinished sentence should get a short request to finish the thought/],
  ])("contains %s", (rule) => {
    expect(SYSTEM_PROMPT).toMatch(rule);
  });

  it("does not seed a made-up fact as an example", () => {
    // Examples in the prompt must not themselves assert facts the model could repeat.
    expect(SYSTEM_PROMPT).not.toMatch(/Art(?:icle)?\s*25|Icehotel|Microsoft Certified/i);
  });

  it("uses a low temperature for factual answers", () => {
    expect(AGENT_TEMPERATURE).toBeLessThanOrEqual(0.1);
  });
});

describe("conversation context resolves acronyms", () => {
  const mcpHistory = [
    { role: "user" as const, text: "What's MCP?" },
    {
      role: "agent" as const,
      text: "MCP stands for Model Context Protocol, an open standard for connecting AI assistants to tools.",
    },
  ];

  it("sends earlier turns with the question, labelled", () => {
    expect(buildPromptWithContext("Who made MCP?", mcpHistory)).toBe(
      "Conversation so far:\n" +
        "User: What's MCP?\n" +
        "Assistant: MCP stands for Model Context Protocol, an open standard for connecting AI assistants to tools.\n\n" +
        "Current message from the user:\nWho made MCP?",
    );
  });

  it("without history it is just the question", () => {
    expect(buildPromptWithContext("What is RAG?", [])).toBe("What is RAG?");
  });

  it("keeps the newest turns within the size cap", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      role: "user" as const,
      text: `turn ${i} ${"x".repeat(150)}`,
    }));
    const prompt = buildPromptWithContext("now", long);
    expect(prompt.length).toBeLessThan(MAX_CONTEXT_CHARS + 100);
    expect(prompt).toContain("turn 39");
    expect(prompt).not.toContain("turn 0 ");
  });

  it("the LLM receives the history (MCP defined earlier)", async () => {
    const saved = { mock: env.VOICE_MOCK, key: env.GEMINI_API_KEY };
    env.VOICE_MOCK = false;
    env.GEMINI_API_KEY = "k";
    generateContentMock.mockReset();
    generateContentMock.mockResolvedValue(geminiOk(agentJson("Model Context Protocol.")));
    try {
      await handleUtterance(
        {
          text: "What does MCP stand for again?",
          sessionId: "s",
          turnIndex: 2,
          sttLatencyMs: 0,
          context: mcpHistory,
        },
        recordingLogger().log,
      );
      const contents = (generateContentMock.mock.calls[0]?.[0] as { contents: string }).contents;
      expect(contents).toContain("MCP stands for Model Context Protocol");
      expect(contents).toMatch(/Current message from the user:\nWhat does MCP stand for again\?$/);
    } finally {
      env.VOICE_MOCK = saved.mock;
      env.GEMINI_API_KEY = saved.key;
    }
  });
});

describe("Groq model and per-reply provider logging", () => {
  const saved = {
    mock: env.VOICE_MOCK,
    gemini: env.GEMINI_API_KEY,
    groq: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
  };
  let groqBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    resetAllCircuits();
    resetUsageMemory();
    generateContentMock.mockReset();
    groqBodies = [];
    Object.assign(env, {
      VOICE_MOCK: false,
      GEMINI_API_KEY: "k",
      GROQ_API_KEY: "g",
      GROQ_MODEL: "openai/gpt-oss-120b",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).startsWith(GROQ_BASE_URL)) throw new Error("unexpected fetch");
        groqBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: agentJson("I'm not sure what ChargeGBT is.") },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(env, {
      VOICE_MOCK: saved.mock,
      GEMINI_API_KEY: saved.gemini,
      GROQ_API_KEY: saved.groq,
      GROQ_MODEL: saved.model,
    });
  });

  it("defaults to Groq's strongest production text model, openai/gpt-oss-120b", () => {
    const parsed = envSchema.parse({ DATABASE_URL: "postgresql://x", JWT_SECRET: "x".repeat(32) });
    expect(parsed.GROQ_MODEL).toBe("openai/gpt-oss-120b");
  });

  it("Groq gets the same low temperature and the 120b model", async () => {
    generateContentMock.mockRejectedValue(geminiDown());
    await safeGenerateAgentOutput("What is the ChargeGBT battery model?", recordingLogger().log);
    expect(groqBodies[0]).toMatchObject({ model: "openai/gpt-oss-120b", temperature: 0.1 });
  });

  it("Gemini gets the low temperature too", async () => {
    generateContentMock.mockResolvedValue(geminiOk(agentJson("hi")));
    await safeGenerateAgentOutput("hi", recordingLogger().log);
    const config = (generateContentMock.mock.calls[0]?.[0] as { config: { temperature: number } })
      .config;
    expect(config.temperature).toBe(0.1);
  });

  it("each reply's pipeline log says which provider produced it", async () => {
    generateContentMock.mockRejectedValue(geminiDown());
    const { log, info } = recordingLogger();
    await handleUtterance(
      {
        text: "What is the ChargeGBT battery model?",
        sessionId: "s",
        turnIndex: 0,
        sttLatencyMs: 0,
      },
      log,
    );
    expect(info.find(([, m]) => m === "Agent pipeline complete")?.[0]).toMatchObject({
      source: "groq/openai/gpt-oss-120b",
      textPreview: "I'm not sure what ChargeGBT is.",
    });
  });

  it("tool answers are logged as source=tool", async () => {
    const { log, info } = recordingLogger();
    await handleUtterance(
      { text: "Translate good morning to Swedish", sessionId: "s", turnIndex: 0, sttLatencyMs: 0 },
      log,
    );
    expect(info.find(([, m]) => m === "Agent pipeline complete")?.[0]).toMatchObject({
      source: "tool",
    });
  });
});
