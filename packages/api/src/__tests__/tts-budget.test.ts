import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { ServerAudioMessage } from "@voice-agent/shared-types";
import { streamTts, isElevenLabsQuotaError } from "../modules/audio/elevenlabs.service.js";
import { env } from "../env.js";
import { getCircuitSnapshot, resetAllCircuits } from "../utils/circuit-breaker.js";
import { getDailyUsage, incrementUsage, resetUsageMemory } from "../utils/usage-tracker.js";

const logStub = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  level: "info",
  silent: vi.fn(),
} as unknown as FastifyBaseLogger;

const saved = {
  voiceMock: env.VOICE_MOCK,
  elevenKey: env.ELEVENLABS_API_KEY,
  deepgramKey: env.DEEPGRAM_API_KEY,
  ttsCap: env.DAILY_MAX_TTS_CHARS,
};

function goLive(deepgramKey = "test-deepgram-key"): void {
  env.VOICE_MOCK = false;
  env.ELEVENLABS_API_KEY = "test-eleven-key";
  env.DEEPGRAM_API_KEY = deepgramKey;
}

beforeEach(() => {
  resetUsageMemory();
  resetAllCircuits();
});

afterEach(() => {
  env.VOICE_MOCK = saved.voiceMock;
  env.ELEVENLABS_API_KEY = saved.elevenKey;
  env.DEEPGRAM_API_KEY = saved.deepgramKey;
  env.DAILY_MAX_TTS_CHARS = saved.ttsCap;
  vi.unstubAllGlobals();
  resetAllCircuits();
  resetUsageMemory();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Responder = (url: string) => Response;

function stubProviders(eleven: Responder, aura: Responder): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("elevenlabs.io")) return eleven(url);
      if (url.includes("api.deepgram.com")) return aura(url);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return urls;
}

const audio = (): Response => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
const status = (code: number, body = "nope"): Response => new Response(body, { status: code });

async function run(text: string): Promise<ServerAudioMessage[]> {
  const chunks: ServerAudioMessage[] = [];
  streamTts(text, (m) => chunks.push(m), logStub, "tts-budget");
  await sleep(150);
  return chunks;
}

const hitEleven = (urls: string[]): boolean => urls.some((u) => u.includes("elevenlabs.io"));
const hitAura = (urls: string[]): boolean => urls.some((u) => u.includes("api.deepgram.com"));
const errors = (c: ServerAudioMessage[]) => c.filter((m) => m.type === "error");

describe("ElevenLabs daily character cap", () => {
  it("uses ElevenLabs and reserves the characters while under the cap", async () => {
    goLive();
    env.DAILY_MAX_TTS_CHARS = 650;
    const urls = stubProviders(audio, audio);

    const chunks = await run("hello there");

    expect(hitEleven(urls)).toBe(true);
    expect(hitAura(urls)).toBe(false);
    expect(chunks.some((c) => c.type === "tts_done")).toBe(true);
    expect((await getDailyUsage()).ttsChars).toBe("hello there".length);
  });

  it("routes straight to Deepgram Aura (no error) when the reply would exceed the cap", async () => {
    goLive();
    env.DAILY_MAX_TTS_CHARS = 650;
    await incrementUsage({ ttsChars: 645 });
    const urls = stubProviders(audio, audio);

    const chunks = await run("hello there");

    expect(hitEleven(urls)).toBe(false);
    expect(hitAura(urls)).toBe(true);
    expect(errors(chunks)).toHaveLength(0);
    expect(chunks.some((c) => c.type === "tts_done")).toBe(true);
    // Aura output does not consume the ElevenLabs budget.
    expect((await getDailyUsage()).ttsChars).toBe(645);
  });

  it("a cap of 0 disables ElevenLabs entirely", async () => {
    goLive();
    env.DAILY_MAX_TTS_CHARS = 0;
    const urls = stubProviders(audio, audio);

    const chunks = await run("hi");

    expect(hitEleven(urls)).toBe(false);
    expect(hitAura(urls)).toBe(true);
    expect(errors(chunks)).toHaveLength(0);
  });

  it("emits tts_budget_exhausted when over the cap and no Aura fallback exists", async () => {
    goLive("");
    env.DAILY_MAX_TTS_CHARS = 5;
    const urls = stubProviders(audio, audio);

    const chunks = await run("hello there");

    expect(urls).toHaveLength(0);
    const err = errors(chunks)[0];
    expect(err?.type === "error" && err.code).toBe("tts_budget_exhausted");
  });

  it("refunds the reservation when ElevenLabs fails before producing audio", async () => {
    goLive();
    env.DAILY_MAX_TTS_CHARS = 650;
    stubProviders(() => status(500), audio);

    await run("hello there");

    expect((await getDailyUsage()).ttsChars).toBe(0);
  });

  it("does not let concurrent replies overshoot the cap", async () => {
    goLive();
    env.DAILY_MAX_TTS_CHARS = 15;
    const urls = stubProviders(audio, audio);

    const a: ServerAudioMessage[] = [];
    const b: ServerAudioMessage[] = [];
    streamTts("ten chars!", (m) => a.push(m), logStub, "tts-a");
    streamTts("ten chars!", (m) => b.push(m), logStub, "tts-b");
    await sleep(150);

    expect(urls.filter((u) => u.includes("elevenlabs.io"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("api.deepgram.com"))).toHaveLength(1);
    expect((await getDailyUsage()).ttsChars).toBe(10);
  });
});

describe("402/429/quota responses are budget exhaustion, not provider faults", () => {
  it.each([402, 429])(
    "ElevenLabs %i falls back to Aura without counting a breaker failure",
    async (code) => {
      goLive();
      const urls = stubProviders(() => status(code), audio);

      const chunks = await run("hello there");

      expect(hitAura(urls)).toBe(true);
      expect(errors(chunks)).toHaveLength(0);
      expect(getCircuitSnapshot("elevenlabs").failures).toBe(0);
    },
  );

  it("ElevenLabs 401 quota_exceeded falls back to Aura without counting a breaker failure", async () => {
    goLive();
    const body = JSON.stringify({
      detail: { status: "quota_exceeded", message: "This request exceeds your quota." },
    });
    const urls = stubProviders(() => status(401, body), audio);

    const chunks = await run("hello there");

    expect(hitAura(urls)).toBe(true);
    expect(errors(chunks)).toHaveLength(0);
    expect(getCircuitSnapshot("elevenlabs").failures).toBe(0);
  });

  it("other ElevenLabs errors still count toward the breaker", async () => {
    goLive();
    stubProviders(() => status(500), audio);

    await run("hello there");

    expect(getCircuitSnapshot("elevenlabs").failures).toBe(1);
  });

  it("ElevenLabs 401 without quota_exceeded is a normal failure", () => {
    expect(isElevenLabsQuotaError(401, '{"detail":{"status":"invalid_api_key"}}')).toBe(false);
    expect(isElevenLabsQuotaError(401, '{"detail":{"status":"quota_exceeded"}}')).toBe(true);
  });

  it.each([402, 429])(
    "Aura %i reports tts_budget_exhausted without counting a breaker failure",
    async (code) => {
      goLive();
      env.DAILY_MAX_TTS_CHARS = 0;
      stubProviders(audio, () => status(code));

      const chunks = await run("hello there");

      const err = errors(chunks)[0];
      expect(err?.type === "error" && err.code).toBe("tts_budget_exhausted");
      expect(getCircuitSnapshot("deepgram").failures).toBe(0);
    },
  );

  it("Aura 500 still counts toward the deepgram breaker", async () => {
    goLive();
    env.DAILY_MAX_TTS_CHARS = 0;
    stubProviders(audio, () => status(500));

    const chunks = await run("hello there");

    const err = errors(chunks)[0];
    expect(err?.type === "error" && err.code).toBe("tts_stream_error");
    expect(getCircuitSnapshot("deepgram").failures).toBe(1);
  });
});
