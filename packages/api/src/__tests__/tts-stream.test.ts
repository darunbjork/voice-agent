import { describe, it, expect, vi } from "vitest";
import { streamTts } from "../modules/audio/elevenlabs.service.js";
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

describe("streamTts (mock mode)", () => {
  it("emits multiple chunks then tts_done", async () => {
    const chunks: ServerAudioMessage[] = [];
    const stream = streamTts("hello there", (m) => chunks.push(m), logStub, "s1");

    await new Promise((r) => setTimeout(r, 600));

    const audioChunks = chunks.filter((c) => c.type === "tts_chunk");
    const done = chunks.find((c) => c.type === "tts_done");

    expect(stream.cancelled).toBe(false);
    expect(audioChunks.length).toBeGreaterThanOrEqual(3);
    expect(done).toBeDefined();

    const seqs = audioChunks.map(
      (c) => (c as Extract<ServerAudioMessage, { type: "tts_chunk" }>).sequenceNum,
    );
    expect(seqs).toEqual(seqs.slice().sort((a, b) => a - b));
    expect(seqs[0]).toBe(0);
  });

  it("cancel stops further chunks and fires exactly one tts_done", async () => {
    const chunks: ServerAudioMessage[] = [];
    const stream = streamTts(
      "a much longer reply to force several chunks",
      (m) => chunks.push(m),
      logStub,
      "s2",
    );

    await new Promise((r) => setTimeout(r, 60));

    const beforeCancel = chunks.length;
    stream.cancel();

    await new Promise((r) => setTimeout(r, 600));

    expect(stream.cancelled).toBe(true);

    const afterCancel = chunks.slice(beforeCancel);
    const doneCount = afterCancel.filter((c) => c.type === "tts_done").length;
    const chunkCount = afterCancel.filter((c) => c.type === "tts_chunk").length;

    expect(doneCount).toBe(1);
    expect(chunkCount).toBe(0);
  });

  it("rejects replies over the per-reply character cap", () => {
    const huge = "x".repeat(1000);
    expect(() => streamTts(huge, () => undefined, logStub, "s3")).toThrowError(/tts_reply/);
  });
});
