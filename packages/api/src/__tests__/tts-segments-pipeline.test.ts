// A reply split into TTS segments (B6e) must still behave as one reply:
// - one audio stream (sequence numbers continue, one tts_done), so the HUD
//   TOTAL stops at the first byte of the FIRST segment (web turn-clock);
// - every segment's characters count toward the daily cap (B1), checked
//   before each segment is sent;
// - a B6d correction ("No, I meant Spanish") is spoken with language_code es;
// - a failed segment is reported to Sentry once and the reply still ends.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { AgentReply, ServerAudioMessage } from "@voice-agent/shared-types";
import type { FastifyBaseLogger } from "fastify";

const { captureServerError } = vi.hoisted(() => ({ captureServerError: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureServerError, initSentry: vi.fn() }));

import { streamTts } from "../modules/audio/elevenlabs.service.js";
import { ttsSegmentsFor } from "../modules/audio/tts-segments.js";
import { handleUtterance } from "../modules/agent/agent.service.js";
import { resetPendingRequests } from "../modules/agent/pending-requests.js";
import { env } from "../env.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { getDailyUsage, incrementUsage, resetUsageMemory } from "../utils/usage-tracker.js";

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
  ttsCap: env.DAILY_MAX_TTS_CHARS,
};

const TEXT = "good night in Swedish is god natt.";
const LEAD = "good night in Swedish is";
const PHRASE = "god natt.";

const swedishReply: AgentReply = {
  text: TEXT,
  intent: "translate",
  card: {
    type: "translate",
    original: "good night",
    translated: "god natt",
    fromLang: "en",
    toLang: "sv",
  },
  latencyMs: { stt: 0, llm: 1, tts: 0, total: 1 },
  sessionId: "s",
  turnIndex: 0,
};

type Call = { url: string; body: Record<string, unknown> };

/** Stubs fetch; `respond` decides each response (default: 64 bytes of audio). */
function stubFetch(respond: (call: Call, n: number) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      calls.push(call);
      return respond(call, calls.length) ?? new Response(new Uint8Array(64), { status: 200 });
    }),
  );
  return calls;
}

function live({ aura }: { aura: boolean }) {
  env.VOICE_MOCK = false;
  env.ELEVENLABS_API_KEY = "test-eleven-key";
  env.DEEPGRAM_API_KEY = aura ? "test-deepgram-key" : "";
}

async function speak(reply: AgentReply): Promise<ServerAudioMessage[]> {
  const msgs: ServerAudioMessage[] = [];
  streamTts(reply.text, (m) => msgs.push(m), log, "s", { segments: ttsSegmentsFor(reply) });
  await vi.waitFor(() =>
    expect(msgs.some((m) => m.type === "tts_done" || m.type === "error")).toBe(true),
  );
  // Let a trailing tts_done after an error arrive too.
  await new Promise((r) => setTimeout(r, 20));
  return msgs;
}

const eleven = (calls: Call[]) => calls.filter((c) => c.url.includes("elevenlabs"));
const aura = (calls: Call[]) => calls.filter((c) => c.url.includes("deepgram"));

beforeEach(() => {
  resetUsageMemory();
  resetAllCircuits();
  resetPendingRequests();
  captureServerError.mockClear();
});

afterEach(() => {
  env.VOICE_MOCK = saved.voiceMock;
  env.ELEVENLABS_API_KEY = saved.elevenKey;
  env.DEEPGRAM_API_KEY = saved.deepgramKey;
  env.DAILY_MAX_TTS_CHARS = saved.ttsCap;
  vi.unstubAllGlobals();
});

describe("segments are one audio stream (TOTAL = first byte of the first segment)", () => {
  it("sequence numbers continue across segments and there is a single tts_done", async () => {
    live({ aura: false });
    stubFetch();
    const msgs = await speak(swedishReply);

    const seq = msgs.flatMap((m) => (m.type === "tts_chunk" ? [m.sequenceNum] : []));
    expect(seq.length).toBeGreaterThanOrEqual(2);
    expect(seq).toEqual(seq.map((_, i) => i)); // 0,1,2… — never restarts at 0
    expect(msgs.filter((m) => m.type === "tts_done")).toHaveLength(1);
    // tts_done only after the last segment's audio.
    expect(msgs.at(-1)?.type).toBe("tts_done");
  });
});

describe("TTS characters and the daily cap, per segment (B1)", () => {
  it("counts the characters of every segment", async () => {
    live({ aura: false });
    stubFetch();
    await speak(swedishReply);
    expect((await getDailyUsage()).ttsChars).toBe(LEAD.length + PHRASE.length);
  });

  it("checks the cap before each segment: a segment that no longer fits is not sent", async () => {
    live({ aura: true });
    env.DAILY_MAX_TTS_CHARS = 100;
    const calls = stubFetch((call, n) => {
      // Another reply uses the budget while the lead-in is being spoken.
      if (n === 1) void incrementUsage({ ttsChars: 100 - LEAD.length - 2 });
      return undefined;
    });
    const msgs = await speak(swedishReply);

    expect(eleven(calls).map((c) => c.body.text)).toEqual([LEAD]);
    expect(aura(calls).map((c) => c.body.text)).toEqual([PHRASE]);
    expect((await getDailyUsage()).ttsChars).toBeLessThanOrEqual(100);
    expect(msgs.filter((m) => m.type === "tts_done")).toHaveLength(1);
    expect(captureServerError).not.toHaveBeenCalled(); // budget is not a fault
  });

  it("refunds a segment that produced no audio, keeps the ones that were spoken", async () => {
    live({ aura: true });
    stubFetch((call, n) =>
      call.url.includes("elevenlabs") && n === 2
        ? new Response("boom", { status: 500 })
        : undefined,
    );
    await speak(swedishReply);
    expect((await getDailyUsage()).ttsChars).toBe(LEAD.length);
  });
});

describe('"No, I meant Spanish" (B6d) is spoken in Spanish', () => {
  it("the corrected translation goes to ElevenLabs with language_code es", async () => {
    const say = (text: string) =>
      handleUtterance({ text, sessionId: "b6e", turnIndex: 0, sttLatencyMs: 0 }, log).then(
        (r) => r.reply,
      );
    await say("Translate to French");
    await say("No, I meant Spanish");
    const reply = await say("goodbye");
    expect(reply.card).toMatchObject({ type: "translate", toLang: "es", translated: "adiós" });

    live({ aura: false });
    const calls = stubFetch();
    await speak(reply);

    const phrase = eleven(calls).at(-1)?.body;
    expect(phrase?.language_code).toBe("es");
    expect(String(phrase?.text)).toContain("adiós");
  });
});

describe("a failed segment: one Sentry event, and the reply still ends", () => {
  it("with Aura: captured once, Aura speaks the rest, one tts_done", async () => {
    live({ aura: true });
    const calls = stubFetch((call, n) =>
      call.url.includes("elevenlabs") && n === 2
        ? new Response("boom", { status: 500 })
        : undefined,
    );
    const msgs = await speak(swedishReply);

    expect(captureServerError).toHaveBeenCalledTimes(1);
    expect(captureServerError.mock.calls[0]?.[1]).toMatchObject({
      where: "tts_elevenlabs_segment",
      segment: "2/2",
      language: "sv",
    });
    expect(aura(calls).map((c) => c.body.text)).toEqual([PHRASE]);
    expect(msgs.filter((m) => m.type === "tts_done")).toHaveLength(1);
    expect(msgs.some((m) => m.type === "error")).toBe(false);
  });

  it("without a fallback: captured once, a visible error, then tts_done so playback ends", async () => {
    live({ aura: false });
    stubFetch((_call, n) => (n === 2 ? new Response("boom", { status: 500 }) : undefined));
    const msgs = await speak(swedishReply);

    expect(captureServerError).toHaveBeenCalledTimes(1);
    const types = msgs.map((m) => m.type);
    expect(types.filter((t) => t === "error")).toHaveLength(1);
    // The lead-in was already played; tts_done lets the player finish it.
    expect(types.at(-1)).toBe("tts_done");
    expect(types.indexOf("tts_chunk")).toBeLessThan(types.indexOf("error"));
  });

  it("a network error mid-segment is captured once too", async () => {
    live({ aura: true });
    stubFetch((call, n) => {
      if (call.url.includes("elevenlabs") && n === 2) throw new Error("socket hang up");
      return undefined;
    });
    await speak(swedishReply);
    expect(captureServerError).toHaveBeenCalledTimes(1);
  });
});
