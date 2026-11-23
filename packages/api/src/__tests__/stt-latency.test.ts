// STT latency is recognition delay only: from the arrival of the audio frame
// holding the utterance's last word (Deepgram word `end` offset) to the
// arrival of Deepgram's final result for it. Speaking time is not included.
// transcript_final also carries sinceSpeechEndMs, so the client can time the
// whole turn: end of speech → first TTS audio byte.
// Live bug: STT was measured from socket open — "STT 108.40 s · Slow".
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { ServerAudioMessage } from "@voice-agent/shared-types";
import { env } from "../env.js";
import { createDeepgramProxy, type DeepgramProxy } from "../modules/audio/deepgram.proxy.js";
import { mergeTranscripts } from "../modules/audio/audio.routes.js";
import { resetAllCircuits } from "../utils/circuit-breaker.js";
import { resetUsageMemory } from "../utils/usage-tracker.js";
import { MOCK_LATENCY } from "../utils/voice-mock.js";

const silentLogger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger;

const PCM_BYTES_PER_SECOND = 32_000;
/** 100 ms of 16 kHz 16-bit mono PCM. */
const FRAME = new ArrayBuffer(PCM_BYTES_PER_SECOND / 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const saved = {
  voiceMock: env.VOICE_MOCK,
  deepgramLive: env.DEEPGRAM_LIVE,
  deepgramKey: env.DEEPGRAM_API_KEY,
};

let server: Server | null = null;
let wss: WebSocketServer | null = null;
let proxy: DeepgramProxy | null = null;
let upstream: ServerSocket | null = null;
let received = 0;

beforeEach(() => {
  resetAllCircuits();
  resetUsageMemory();
  received = 0;
});

afterEach(async () => {
  proxy?.close();
  proxy = null;
  wss?.close();
  wss = null;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  upstream = null;
  env.VOICE_MOCK = saved.voiceMock;
  env.DEEPGRAM_LIVE = saved.deepgramLive;
  env.DEEPGRAM_API_KEY = saved.deepgramKey;
});

async function fakeDeepgram(): Promise<string> {
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    upstream = ws;
    ws.on("message", (data, isBinary) => {
      if (isBinary) received += (data as Buffer).byteLength;
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

/** A Deepgram Results message; `words` are [start, end] audio offsets in seconds. */
function results(transcript: string, isFinal: boolean, words?: Array<[number, number]>): string {
  return JSON.stringify({
    type: "Results",
    is_final: isFinal,
    channel: {
      alternatives: [
        {
          transcript,
          ...(words ? { words: words.map(([start, end]) => ({ word: "w", start, end })) } : {}),
        },
      ],
    },
  });
}

const finals = (msgs: ServerAudioMessage[]) =>
  msgs.flatMap((m) => (m.type === "transcript_final" ? [m] : []));

function openLive(endpoint: string, msgs: ServerAudioMessage[]): DeepgramProxy {
  return createDeepgramProxy((m) => msgs.push(m), silentLogger, "lat", undefined, { endpoint });
}

describe("STT recognition delay (live proxy)", () => {
  beforeEach(() => {
    env.VOICE_MOCK = false;
    env.DEEPGRAM_LIVE = true;
    env.DEEPGRAM_API_KEY = "test-deepgram-key";
  });

  it("a 4 s utterance with a 200 ms recognition delay shows ~200 ms, not ~4.2 s", async () => {
    const endpoint = await fakeDeepgram();
    const msgs: ServerAudioMessage[] = [];
    proxy = openLive(endpoint, msgs);

    // 4 s of speech, sent in real time (frame i covers i*0.1 … i*0.1+0.1 s).
    for (let i = 0; i < 40; i++) {
      proxy.sendAudio(FRAME);
      if (i === 10) upstream?.send(results("so I was", false, [[0.1, 0.4]]));
      await sleep(100);
    }
    await waitUntil(() => received >= 40 * FRAME.byteLength);

    // Last word ends at 3.95 s (inside the last frame); Deepgram finalises 200 ms later.
    await sleep(100); // the last frame arrived ~100 ms ago
    await sleep(100);
    upstream!.send(
      results("so I was thinking about tomorrow", true, [
        [0.1, 0.4],
        [3.6, 3.95],
      ]),
    );
    // Deepgram's UtteranceEnd follows after its silence window.
    await sleep(300);
    upstream!.send(JSON.stringify({ type: "UtteranceEnd" }));
    await waitUntil(() => finals(msgs).length === 1);

    const final = finals(msgs)[0]!;
    expect(final.latencyMs).toBeGreaterThanOrEqual(150);
    expect(final.latencyMs).toBeLessThan(400);
    // Whole-turn anchor: speech ended ~200 + 300 ms before the final was sent.
    expect(final.sinceSpeechEndMs).toBeGreaterThanOrEqual(450);
    expect(final.sinceSpeechEndMs).toBeLessThan(800);
  }, 10_000);

  it("uses the last word of the last final segment of the utterance", async () => {
    const endpoint = await fakeDeepgram();
    const msgs: ServerAudioMessage[] = [];
    proxy = openLive(endpoint, msgs);

    for (let i = 0; i < 10; i++) {
      proxy.sendAudio(FRAME);
      await sleep(50);
    }
    await waitUntil(() => upstream !== null && received >= 10 * FRAME.byteLength);
    upstream!.send(results("first part", true, [[0.0, 0.3]]));
    await sleep(250);
    upstream!.send(results("second part", true, [[0.5, 0.95]]));
    upstream!.send(JSON.stringify({ type: "UtteranceEnd" }));
    await waitUntil(() => finals(msgs).length === 1);

    // Frame 9 (0.9–1.0 s) arrived ~0 ms after the loop ended; the final came ~250 ms later.
    expect(finals(msgs)[0]!.latencyMs).toBeGreaterThanOrEqual(200);
    expect(finals(msgs)[0]!.latencyMs).toBeLessThan(450);
  });

  it("without word timings, measures from the last audio frame before the final", async () => {
    const endpoint = await fakeDeepgram();
    const msgs: ServerAudioMessage[] = [];
    proxy = openLive(endpoint, msgs);

    for (let i = 0; i < 20; i++) {
      proxy.sendAudio(FRAME);
      await sleep(50);
    }
    await waitUntil(() => upstream !== null && received >= 20 * FRAME.byteLength);
    await sleep(150);
    upstream!.send(results("no timings", true));
    upstream!.send(JSON.stringify({ type: "UtteranceEnd" }));
    await waitUntil(() => finals(msgs).length === 1);

    expect(finals(msgs)[0]!.latencyMs).toBeGreaterThanOrEqual(130);
    expect(finals(msgs)[0]!.latencyMs).toBeLessThan(400);
  });
});

describe("mock proxy and merged utterances", () => {
  it("the mock final reports the fixed mock STT latency and a speech-end anchor", async () => {
    env.VOICE_MOCK = true;
    env.DEEPGRAM_LIVE = false;
    const msgs: ServerAudioMessage[] = [];
    proxy = createDeepgramProxy((m) => msgs.push(m), silentLogger, "mock-lat");
    for (let i = 0; i < 8; i++) proxy.sendAudio(FRAME);
    const final = finals(msgs)[0]!;
    expect(final.latencyMs).toBe(MOCK_LATENCY.stt);
    expect(final.sinceSpeechEndMs).toBe(0);
  });

  it("a merged utterance keeps the later part's timings", () => {
    expect(
      mergeTranscripts(
        { type: "transcript_final", text: "Can I build", latencyMs: 10, sinceSpeechEndMs: 900 },
        { type: "transcript_final", text: "an app?", latencyMs: 20, sinceSpeechEndMs: 400 },
      ),
    ).toEqual({
      type: "transcript_final",
      text: "Can I build an app?",
      latencyMs: 20,
      sinceSpeechEndMs: 400,
    });
  });
});
