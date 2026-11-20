import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { ServerAudioMessage } from "@voice-agent/shared-types";
import { Pcm16Aligner } from "../utils/pcm-align.js";
import { streamTts } from "../modules/audio/elevenlabs.service.js";
import { env } from "../env.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";

/** 16-bit little-endian samples 0x0102, 0x0304, … as bytes. */
function samples(n: number): Uint8Array {
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = (i * 2 + 2) & 0xff;
    out[i * 2 + 1] = (i * 2 + 1) & 0xff;
  }
  return out;
}

function concat(parts: ArrayBuffer[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), o);
    o += p.byteLength;
  }
  return out;
}

/** Split bytes into the given chunk sizes (as an HTTP stream might). */
function split(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let o = 0;
  for (const size of sizes) {
    out.push(bytes.slice(o, o + size));
    o += size;
  }
  if (o < bytes.byteLength) out.push(bytes.slice(o));
  return out;
}

describe("Pcm16Aligner", () => {
  it("passes even chunks through unchanged", () => {
    const a = new Pcm16Aligner();
    const out = a.push(samples(4));
    expect(new Uint8Array(out!)).toEqual(samples(4));
    expect(a.oddChunks).toBe(0);
  });

  it("carries an odd trailing byte so every output chunk is whole samples", () => {
    const input = samples(50);
    const a = new Pcm16Aligner();
    const outs = split(input, [1, 3, 7, 2, 11, 1, 1, 30])
      .map((c) => a.push(c))
      .filter((b): b is ArrayBuffer => b !== null);

    for (const o of outs) expect(o.byteLength % 2).toBe(0);
    expect(concat(outs)).toEqual(input);
    expect(a.oddChunks).toBe(6);
  });

  it("holds a single byte until its pair arrives", () => {
    const a = new Pcm16Aligner();
    expect(a.push(new Uint8Array([0x01]))).toBeNull();
    expect(new Uint8Array(a.push(new Uint8Array([0x02]))!)).toEqual(new Uint8Array([1, 2]));
  });

  it("reset drops a pending half sample", () => {
    const a = new Pcm16Aligner();
    a.push(new Uint8Array([0xaa, 0xbb, 0xcc]));
    a.reset();
    expect(new Uint8Array(a.push(new Uint8Array([1, 2]))!)).toEqual(new Uint8Array([1, 2]));
  });
});

describe("streamTts forwards sample-aligned PCM from both providers", () => {
  const logStub = {
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

  afterEach(() => {
    Object.assign(env, {
      VOICE_MOCK: saved.voiceMock,
      ELEVENLABS_API_KEY: saved.elevenKey,
      DEEPGRAM_API_KEY: saved.deepgramKey,
      DAILY_MAX_TTS_CHARS: saved.ttsCap,
    });
    vi.unstubAllGlobals();
    resetAllCircuits();
    resetUsageMemory();
  });

  /** A streamed body that yields odd-sized network reads. */
  function oddStream(bytes: Uint8Array): Response {
    const parts = split(bytes, [3, 5, 1, 9, 7, 13]);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      }),
      { status: 200 },
    );
  }

  it.each([
    ["ElevenLabs", 650],
    ["Deepgram Aura", 0],
  ])("%s: every tts_chunk is even-length and the audio is intact", async (_name, cap) => {
    env.VOICE_MOCK = false;
    env.ELEVENLABS_API_KEY = "test-eleven-key";
    env.DEEPGRAM_API_KEY = "test-deepgram-key";
    env.DAILY_MAX_TTS_CHARS = cap;
    const audio = samples(40);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => oddStream(audio)),
    );

    const chunks: ServerAudioMessage[] = [];
    streamTts("hello", (m) => chunks.push(m), logStub, "pcm");
    await new Promise((r) => setTimeout(r, 100));

    const pcm = chunks.flatMap((c) => (c.type === "tts_chunk" ? [c.audio] : []));
    expect(pcm.length).toBeGreaterThan(0);
    for (const p of pcm) expect(p.byteLength % 2).toBe(0);
    expect(concat(pcm)).toEqual(audio);
    const seq = chunks.flatMap((c) => (c.type === "tts_chunk" ? [c.sequenceNum] : []));
    expect(seq).toEqual(seq.map((_, i) => i));
    expect(chunks.some((c) => c.type === "tts_done")).toBe(true);
  });
});
