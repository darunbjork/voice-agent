// A translation is spoken in its own language: the translated phrase goes to
// ElevenLabs with language_code (e.g. "sv"), the English lead-in without it.
// Live bug: "god natt" was read with English pronunciation.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { AgentReply, ServerAudioMessage } from "@voice-agent/shared-types";
import type { FastifyBaseLogger } from "fastify";
import { streamTts } from "../modules/audio/elevenlabs.service.js";
import { ttsSegmentsFor } from "../modules/audio/tts-segments.js";
import { env } from "../env.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as FastifyBaseLogger;

const saved = {
  voiceMock: env.VOICE_MOCK,
  elevenKey: env.ELEVENLABS_API_KEY,
  deepgramKey: env.DEEPGRAM_API_KEY,
};

afterEach(() => {
  env.VOICE_MOCK = saved.voiceMock;
  env.ELEVENLABS_API_KEY = saved.elevenKey;
  env.DEEPGRAM_API_KEY = saved.deepgramKey;
  vi.unstubAllGlobals();
  resetAllCircuits();
  resetUsageMemory();
});

const translateReply = (text: string, translated: string, toLang: string): AgentReply => ({
  text,
  intent: "translate",
  card: { type: "translate", original: "good night", translated, fromLang: "en", toLang },
  latencyMs: { stt: 0, llm: 1, tts: 0, total: 1 },
  sessionId: "s",
  turnIndex: 0,
});

describe("ttsSegmentsFor", () => {
  it("splits a translation into the English lead-in and the phrase in its language", () => {
    expect(
      ttsSegmentsFor(translateReply("good night in Swedish is god natt.", "god natt", "sv")),
    ).toEqual([
      { text: "good night in Swedish is", languageCode: "en" },
      { text: "god natt.", languageCode: "sv" },
    ]);
  });

  it("other replies are one segment without a language", () => {
    const reply = {
      ...translateReply("It is 5°C in Oslo.", "", "en"),
      intent: "weather",
      card: null,
    } as AgentReply;
    expect(ttsSegmentsFor(reply)).toEqual([{ text: "It is 5°C in Oslo." }]);
  });

  it("a language ElevenLabs Turbo v2.5 cannot enforce gets no language_code", () => {
    expect(
      ttsSegmentsFor(translateReply("good night in Icelandic is góða nótt.", "góða nótt", "is")),
    ).toEqual([{ text: "good night in Icelandic is góða nótt." }]);
  });

  it("a reply that does not contain the translation is spoken as it is", () => {
    expect(
      ttsSegmentsFor(translateReply("I do not have a translation for that yet.", "god natt", "sv")),
    ).toEqual([{ text: "I do not have a translation for that yet." }]);
  });
});

describe("streamTts sends each segment with its language", () => {
  it("two ElevenLabs requests, phrase with language_code, audio in order, one tts_done", async () => {
    env.VOICE_MOCK = false;
    env.ELEVENLABS_API_KEY = "test-eleven-key";
    env.DEEPGRAM_API_KEY = "";
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        const marker = bodies.length; // segment 1 → bytes of 1, segment 2 → bytes of 2
        return new Response(new Uint8Array(64).fill(marker), { status: 200 });
      }),
    );

    const segments = ttsSegmentsFor(
      translateReply("good night in Swedish is god natt.", "god natt", "sv"),
    );
    const msgs: ServerAudioMessage[] = [];
    streamTts("good night in Swedish is god natt.", (m) => msgs.push(m), log, "s", { segments });
    await vi.waitFor(() => expect(msgs.some((m) => m.type === "tts_done")).toBe(true));

    expect(bodies.map((b) => [b.text, b.language_code])).toEqual([
      ["good night in Swedish is", "en"],
      ["god natt.", "sv"],
    ]);
    const audio = msgs.flatMap((m) => (m.type === "tts_chunk" ? [new Uint8Array(m.audio)[0]] : []));
    expect(audio[0]).toBe(1);
    expect(audio.at(-1)).toBe(2);
    expect(msgs.filter((m) => m.type === "tts_done")).toHaveLength(1);
    expect(msgs.some((m) => m.type === "error")).toBe(false);
  });

  it("if the phrase fails after the lead-in was spoken, Aura speaks only the rest", async () => {
    env.VOICE_MOCK = false;
    env.ELEVENLABS_API_KEY = "test-eleven-key";
    env.DEEPGRAM_API_KEY = "test-deepgram-key";
    const calls: Array<{ url: string; text: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { text: unknown };
        calls.push({ url, text: body.text });
        if (url.includes("elevenlabs") && calls.length === 2) {
          return new Response("upstream error", { status: 500 });
        }
        return new Response(new Uint8Array(32), { status: 200 });
      }),
    );
    const segments = ttsSegmentsFor(
      translateReply("good night in Swedish is god natt.", "god natt", "sv"),
    );
    const msgs: ServerAudioMessage[] = [];
    streamTts("good night in Swedish is god natt.", (m) => msgs.push(m), log, "s", { segments });
    await vi.waitFor(() => expect(msgs.some((m) => m.type === "tts_done")).toBe(true));

    const aura = calls.filter((c) => c.url.includes("deepgram"));
    expect(aura.map((c) => c.text)).toEqual(["god natt."]);
  });

  it("without segments the request has no language_code (unchanged)", async () => {
    env.VOICE_MOCK = false;
    env.ELEVENLABS_API_KEY = "test-eleven-key";
    env.DEEPGRAM_API_KEY = "";
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(new Uint8Array(32), { status: 200 });
      }),
    );
    const msgs: ServerAudioMessage[] = [];
    streamTts("hello there", (m) => msgs.push(m), log, "s");
    await vi.waitFor(() => expect(msgs.some((m) => m.type === "tts_done")).toBe(true));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("language_code");
  });
});
