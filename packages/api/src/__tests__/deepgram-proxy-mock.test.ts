import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { ServerAudioMessage } from "@voice-agent/shared-types";
import { createDeepgramProxy } from "../modules/audio/deepgram.proxy.js";

const silentLogger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger;

describe("deepgram proxy (VOICE_MOCK=true)", () => {
  let finals: string[];
  let interims: string[];
  let proxy: ReturnType<typeof createDeepgramProxy>;

  const sendChunk = () => proxy.sendAudio(new ArrayBuffer(64));

  const sendBurst = (chunks: number) => {
    for (let i = 0; i < chunks; i++) sendChunk();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    finals = [];
    interims = [];
    proxy = createDeepgramProxy(
      (msg: ServerAudioMessage) => {
        if (msg.type === "transcript_final") finals.push(msg.text);
        if (msg.type === "transcript_interim") interims.push(msg.text);
      },
      silentLogger,
      "sess_test",
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits one interim and one final per audio burst", () => {
    sendBurst(8);
    expect(interims).toHaveLength(1);
    expect(finals).toHaveLength(1);

    sendBurst(32);
    expect(interims).toHaveLength(1);
    expect(finals).toHaveLength(1);
  });

  it("re-arms after a pause in audio and fires again on the next burst", () => {
    sendBurst(8);
    expect(finals).toHaveLength(1);

    vi.advanceTimersByTime(300);
    sendBurst(8);
    expect(finals).toHaveLength(1);

    vi.advanceTimersByTime(600);
    sendBurst(8);
    expect(interims).toHaveLength(2);
    expect(finals).toHaveLength(2);
  });

  it("ignores audio after close", () => {
    proxy.close();
    sendBurst(8);
    expect(finals).toHaveLength(0);
    expect(proxy.ready).toBe(false);
  });
});
