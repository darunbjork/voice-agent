import { describe, it, expect, vi, afterEach } from "vitest";
import { streamTts } from "../modules/audio/elevenlabs.service.js";
import { env } from "../env.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import type { ServerAudioMessage } from "@voice-agent/shared-types";
import type { FastifyBaseLogger } from "fastify";

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
};

function goLive(deepgramKey = "test-deepgram-key"): void {
  env.VOICE_MOCK = false;
  env.ELEVENLABS_API_KEY = "test-eleven-key";
  env.DEEPGRAM_API_KEY = deepgramKey;
}

afterEach(() => {
  env.VOICE_MOCK = saved.voiceMock;
  env.ELEVENLABS_API_KEY = saved.elevenKey;
  env.DEEPGRAM_API_KEY = saved.deepgramKey;
  vi.unstubAllGlobals();
  resetAllCircuits();
});

function paymentRequired(): Response {
  return new Response(
    JSON.stringify({
      detail: {
        type: "payment_required",
        code: "paid_plan_required",
        message: "Free users cannot use library voices via the API.",
      },
    }),
    { status: 402, headers: { "content-type": "application/json" } },
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("streamTts provider fallback (live mode, stubbed providers)", () => {
  it("falls back to Deepgram Aura when ElevenLabs returns 402", async () => {
    goLive();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("elevenlabs.io")) return paymentRequired();
        if (url.includes("api.deepgram.com")) {
          return new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const chunks: ServerAudioMessage[] = [];
    const stream = streamTts("hello there", (m) => chunks.push(m), logStub, "tts-fb-1");
    await sleep(300);

    expect(urls.some((u) => u.includes("elevenlabs.io"))).toBe(true);
    expect(urls.some((u) => u.includes("api.deepgram.com"))).toBe(true);
    expect(chunks.filter((c) => c.type === "error")).toHaveLength(0);
    expect(chunks.filter((c) => c.type === "tts_chunk").length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.type === "tts_done")).toBe(true);
    expect(stream.cancelled).toBe(false);
  });

  it("emits the original ElevenLabs error when no Deepgram key is configured", async () => {
    goLive("");
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("elevenlabs.io")) return paymentRequired();
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const chunks: ServerAudioMessage[] = [];
    streamTts("hello there", (m) => chunks.push(m), logStub, "tts-fb-2");
    await sleep(300);

    expect(urls.some((u) => u.includes("api.deepgram.com"))).toBe(false);
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.code).toBe("tts_http_error");
      expect(err.message).toContain("ElevenLabs 402");
    }
  });

  it("streams ElevenLabs directly when it succeeds", async () => {
    goLive();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("elevenlabs.io")) {
          return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const chunks: ServerAudioMessage[] = [];
    streamTts("hello there", (m) => chunks.push(m), logStub, "tts-fb-3");
    await sleep(300);

    expect(urls.some((u) => u.includes("api.deepgram.com"))).toBe(false);
    expect(chunks.filter((c) => c.type === "tts_chunk").length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.type === "tts_done")).toBe(true);
    expect(chunks.filter((c) => c.type === "error")).toHaveLength(0);
  });

  it("reports an error when both providers fail", async () => {
    goLive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("elevenlabs.io")) return paymentRequired();
        if (url.includes("api.deepgram.com")) {
          return new Response("quota exceeded", { status: 500 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const chunks: ServerAudioMessage[] = [];
    streamTts("hello there", (m) => chunks.push(m), logStub, "tts-fb-4");
    await sleep(300);

    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") {
      expect(err.message).toContain("Deepgram 500");
    }
    expect(chunks.some((c) => c.type === "tts_done")).toBe(false);
  });
});
