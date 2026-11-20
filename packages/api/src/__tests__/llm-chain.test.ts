import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../env.js";
import {
  llmChain,
  runWithFallback,
  LlmUnavailableError,
  type LlmAttempt,
} from "../modules/agent/llm.call.js";
import { GROQ_BASE_URL } from "../modules/agent/groq.client.js";
import { safeGenerateAgentOutput } from "../modules/agent/gemini.service.js";
import { generateToolText } from "../modules/agent/gemini.tools.js";
import {
  AGENT_RESPONSE_JSON_SCHEMA_STRICT,
  GEMINI_AGENT_RESPONSE_JSON_SCHEMA,
  toStrictJsonSchema,
} from "../modules/agent/gemini.schema.js";
import {
  CircuitOpenError,
  getCircuitSnapshot,
  recordFailure,
  resetAllCircuits,
} from "../utils/circuit-breaker.js";
import { AgentTurnAbortedError } from "../utils/turn-abort.js";

// Gemini SDK mock.
const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
}));

type LogCall = [Record<string, unknown>, string];
function recordingLogger() {
  const calls: Record<"info" | "warn" | "error", LogCall[]> = { info: [], warn: [], error: [] };
  const log = {
    info: (o: Record<string, unknown>, m: string) => calls.info.push([o, m]),
    warn: (o: Record<string, unknown>, m: string) => calls.warn.push([o, m]),
    error: (o: Record<string, unknown>, m: string) => calls.error.push([o, m]),
    debug: () => undefined,
    child: () => log,
  };
  return { log: log as unknown as FastifyBaseLogger, calls };
}

const geminiOk = (text: string) => ({ text, candidates: [{ finishReason: "STOP" }] });
const geminiError = (code: number) =>
  Object.assign(new Error(`{"error":{"code":${code},"message":"high demand"}}`), { status: code });

// Groq mock: a fetch stub answering https://api.groq.com/openai/v1/chat/completions.
type GroqBody = Record<string, unknown> & {
  model: string;
  messages: Array<{ role: string; content: string }>;
};
const groqRequests: Array<{ url: string; headers: Record<string, string>; body: GroqBody }> = [];
let groqReply: () => Response;

const groqCompletion = (content: string, finish = "stop") =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
      usage: { prompt_tokens: 300, completion_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const groqStatus = (status: number) =>
  new Response(JSON.stringify({ error: { message: "rate limit", type: "tokens" } }), { status });

const agentJson = (reply: string) => JSON.stringify({ reply, intent: "general", card: null });

/** Never settles until aborted, like the hung Gemini requests seen live. */
const hang = (signal: AbortSignal) =>
  new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(new Error("aborted"))),
  );

const saved = {
  mock: env.VOICE_MOCK,
  gemini: env.GEMINI_API_KEY,
  model: env.GEMINI_MODEL,
  fallback: env.GEMINI_FALLBACK_MODEL,
  groq: env.GROQ_API_KEY,
  groqModel: env.GROQ_MODEL,
};

beforeEach(() => {
  resetAllCircuits();
  generateContentMock.mockReset();
  groqRequests.length = 0;
  groqReply = () => groqCompletion(agentJson("from groq"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(GROQ_BASE_URL)) throw new Error(`unexpected fetch ${url}`);
      groqRequests.push({
        url,
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as GroqBody,
      });
      return groqReply();
    }),
  );
  Object.assign(env, {
    VOICE_MOCK: false,
    GEMINI_API_KEY: "gemini-key",
    GEMINI_MODEL: "gemini-primary",
    GEMINI_FALLBACK_MODEL: "gemini-fallback",
    GROQ_API_KEY: "groq-key",
    GROQ_MODEL: "openai/gpt-oss-20b",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(env, {
    VOICE_MOCK: saved.mock,
    GEMINI_API_KEY: saved.gemini,
    GEMINI_MODEL: saved.model,
    GEMINI_FALLBACK_MODEL: saved.fallback,
    GROQ_API_KEY: saved.groq,
    GROQ_MODEL: saved.groqModel,
  });
  resetAllCircuits();
});

describe("llmChain", () => {
  it("is Gemini primary → Gemini fallback → Groq", () => {
    expect(llmChain()).toEqual([
      { provider: "gemini", model: "gemini-primary" },
      { provider: "gemini", model: "gemini-fallback" },
      { provider: "groq", model: "openai/gpt-oss-20b" },
    ]);
  });

  it("skips Groq when GROQ_API_KEY is unset", () => {
    env.GROQ_API_KEY = "";
    expect(llmChain().map((c) => c.provider)).toEqual(["gemini", "gemini"]);
  });

  it("drops an empty or duplicate Gemini fallback", () => {
    env.GEMINI_FALLBACK_MODEL = "";
    expect(llmChain().map((c) => c.model)).toEqual(["gemini-primary", "openai/gpt-oss-20b"]);
    env.GEMINI_FALLBACK_MODEL = "gemini-primary";
    expect(llmChain().map((c) => c.model)).toEqual(["gemini-primary", "openai/gpt-oss-20b"]);
  });

  it("can run on Groq alone", () => {
    env.GEMINI_API_KEY = "";
    expect(llmChain()).toEqual([{ provider: "groq", model: "openai/gpt-oss-20b" }]);
  });
});

describe("runWithFallback (generic chain)", () => {
  const opts = { attemptTimeoutMs: 200, hedgeAfterMs: 50 };
  const attempt = (
    provider: "gemini" | "groq",
    model: string,
    run: LlmAttempt["run"],
  ): LlmAttempt => ({ provider, model, run });

  it("returns the first provider's answer without starting the others when it is fast", async () => {
    const second = vi.fn();
    const r = await runWithFallback(
      [attempt("gemini", "a", async () => ({ text: "A" })), attempt("groq", "b", second)],
      opts,
    );
    expect(r).toMatchObject({ provider: "gemini", model: "a", text: "A" });
    expect(second).not.toHaveBeenCalled();
  });

  it("moves on immediately when an attempt fails", async () => {
    const t = Date.now();
    const r = await runWithFallback(
      [
        attempt("gemini", "a", async () => Promise.reject(geminiError(503))),
        attempt("gemini", "b", async () => Promise.reject(geminiError(503))),
        attempt("groq", "c", async () => ({ text: "C" })),
      ],
      opts,
    );
    expect(r.provider).toBe("groq");
    expect(Date.now() - t).toBeLessThan(50);
  });

  it("hedges past hung attempts and aborts them once one answers", async () => {
    const signals: AbortSignal[] = [];
    const r = await runWithFallback(
      [
        attempt("gemini", "a", (s) => (signals.push(s), hang(s))),
        attempt("gemini", "b", (s) => (signals.push(s), hang(s))),
        attempt("groq", "c", async () => ({ text: "C" })),
      ],
      opts,
    );
    expect(r.model).toBe("c");
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("gives up with LlmUnavailableError listing every provider when all hang", async () => {
    const err = await runWithFallback(
      [attempt("gemini", "a", hang), attempt("groq", "c", hang)],
      opts,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).failures.map((f) => `${f.provider}/${f.model}`)).toEqual([
      "gemini/a",
      "groq/c",
    ]);
  });

  it("skips a provider whose circuit is open", async () => {
    for (let i = 0; i < 5; i++) recordFailure("gemini");
    const gemini = vi.fn();
    const r = await runWithFallback(
      [attempt("gemini", "a", gemini), attempt("groq", "c", async () => ({ text: "C" }))],
      opts,
    );
    expect(gemini).not.toHaveBeenCalled();
    expect(r.provider).toBe("groq");
  });

  it("throws CircuitOpenError when every provider's circuit is open", async () => {
    for (let i = 0; i < 5; i++) {
      recordFailure("gemini");
      recordFailure("groq");
    }
    await expect(
      runWithFallback([attempt("gemini", "a", hang), attempt("groq", "c", hang)], opts),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("aborting the turn cancels every attempt", async () => {
    const turn = new AbortController();
    const p = runWithFallback([attempt("gemini", "a", hang), attempt("groq", "c", hang)], {
      ...opts,
      signal: turn.signal,
    });
    setTimeout(() => turn.abort("barge_in"), 20);
    await expect(p).rejects.toBeInstanceOf(AgentTurnAbortedError);
  });
});

describe("Groq request contract (mocked)", () => {
  it("sends the agent prompt with strict JSON Schema, low reasoning and the key", async () => {
    generateContentMock.mockRejectedValue(geminiError(503));
    await safeGenerateAgentOutput("How many states does the USA have?", recordingLogger().log);

    expect(groqRequests).toHaveLength(1);
    const { url, headers, body } = groqRequests[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(headers.Authorization).toBe("Bearer groq-key");
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toMatch(
      /^Current date and time: .+\(Europe\/Stockholm\)\n\n/,
    );
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "How many states does the USA have?",
    });
    expect(body.reasoning_effort).toBe("low");
    expect(body.temperature).toBe(0.3);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "agent_reply", strict: true, schema: AGENT_RESPONSE_JSON_SCHEMA_STRICT },
    });
  });

  it("strict schema closes every object (additionalProperties: false) and keeps the shapes", () => {
    const strict = AGENT_RESPONSE_JSON_SCHEMA_STRICT as {
      additionalProperties: boolean;
      properties: { card: { anyOf: Array<{ additionalProperties?: boolean; type: string }> } };
    };
    expect(strict.additionalProperties).toBe(false);
    for (const branch of strict.properties.card.anyOf) {
      if (branch.type === "object") expect(branch.additionalProperties).toBe(false);
    }
    expect(toStrictJsonSchema({ type: "string" })).toEqual({ type: "string" });
    // Original Gemini schema is untouched.
    expect("additionalProperties" in GEMINI_AGENT_RESPONSE_JSON_SCHEMA).toBe(false);
  });

  it("tool calls (translate/summarize) send plain text, no response_format", async () => {
    generateContentMock.mockRejectedValue(geminiError(503));
    groqReply = () => groqCompletion("god natt");
    const out = await generateToolText("Translate to Swedish.", "goodnight");
    expect(out).toBe("god natt");
    expect(groqRequests[0]?.body.response_format).toBeUndefined();
    expect(groqRequests[0]?.body.temperature).toBe(0.2);
  });
});

describe("agent with Gemini down (as at 15:40–15:42 UTC)", () => {
  it("answers from Groq and logs which provider answered", async () => {
    generateContentMock.mockRejectedValue(geminiError(503));
    groqReply = () => groqCompletion(agentJson("The United States has 50 states."));
    const { log, calls } = recordingLogger();

    const out = await safeGenerateAgentOutput("How many states does the USA have?", log);

    expect(out).toEqual({
      reply: "The United States has 50 states.",
      intent: "general",
      card: null,
    });
    expect(generateContentMock.mock.calls.map((c) => (c[0] as { model: string }).model)).toEqual([
      "gemini-primary",
      "gemini-fallback",
    ]);
    expect(calls.info.find(([, m]) => m === "LLM response")?.[0]).toMatchObject({
      provider: "groq",
      model: "openai/gpt-oss-20b",
      finishReason: "stop",
    });
    // Gemini failed (one count), Groq succeeded.
    expect(getCircuitSnapshot("gemini").failures).toBe(1);
    expect(getCircuitSnapshot("groq").failures).toBe(0);
  });

  it("goes straight to Groq while the Gemini circuit is open", async () => {
    for (let i = 0; i < 5; i++) recordFailure("gemini");
    const out = await safeGenerateAgentOutput("How are you?", recordingLogger().log);
    expect(out.reply).toBe("from groq");
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("a Groq 429 is budget exhausted: no Groq breaker count, clear reply to the user", async () => {
    generateContentMock.mockRejectedValue(geminiError(503));
    groqReply = () => groqStatus(429);

    const out = await safeGenerateAgentOutput("How are you?", recordingLogger().log);

    expect(out.reply).toBe(
      "I could not reach my language model just now. Please ask again in a moment.",
    );
    expect(getCircuitSnapshot("groq").failures).toBe(0);
    expect(getCircuitSnapshot("gemini").failures).toBe(1);
  });

  it("a Groq 500 does count toward the Groq breaker", async () => {
    generateContentMock.mockRejectedValue(geminiError(503));
    groqReply = () => groqStatus(500);
    await safeGenerateAgentOutput("How are you?", recordingLogger().log);
    expect(getCircuitSnapshot("groq").failures).toBe(1);
  });

  it("a Gemini 429 everywhere, with Groq unset, counts nothing", async () => {
    env.GROQ_API_KEY = "";
    generateContentMock.mockRejectedValue(geminiError(429));
    await safeGenerateAgentOutput("How are you?", recordingLogger().log);
    expect(getCircuitSnapshot("gemini").failures).toBe(0);
    expect(groqRequests).toHaveLength(0);
  });

  it("never calls Groq while Gemini answers", async () => {
    generateContentMock.mockResolvedValue(geminiOk(agentJson("hi")));
    const out = await safeGenerateAgentOutput("How are you?", recordingLogger().log);
    expect(out.reply).toBe("hi");
    expect(groqRequests).toHaveLength(0);
  });

  it("validates Groq output with the same Zod contract (bad card dropped, reply kept)", async () => {
    generateContentMock.mockRejectedValue(geminiError(503));
    groqReply = () =>
      groqCompletion(
        JSON.stringify({ reply: "god natt", intent: "translate", card: { type: "translation" } }),
      );
    const out = await safeGenerateAgentOutput("goodnight in Swedish", recordingLogger().log);
    expect(out).toEqual({ reply: "god natt", intent: "translate", card: null });
  });
});
