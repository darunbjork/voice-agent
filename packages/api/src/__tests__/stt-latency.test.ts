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
/** Poll interval for waitUntil only — never used to wait for time to pass. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

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
    await tick();
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
const interims = (msgs: ServerAudioMessage[]) =>
  msgs.filter((m) => m.type === "transcript_interim").length;

/**
 * Fake clock injected into the proxy: time only moves when the test sets it,
 * so latencies are exact and no real sleeps are needed. The socket I/O to
 * the fake Deepgram is still real, so each step waits for an event.
 */
let clock = 0;

function openLive(endpoint: string, msgs: ServerAudioMessage[]): DeepgramProxy {
  return createDeepgramProxy((m) => msgs.push(m), silentLogger, "lat", undefined, {
    endpoint,
    now: () => clock,
  });
}

/**
 * Sends a Deepgram final at fake time `at` and waits until the proxy has read
 * it (a final is echoed as transcript_interim), so the clock is not moved
 * before the proxy took its arrival time.
 */
async function sendFinal(msgs: ServerAudioMessage[], at: number, message: string): Promise<void> {
  clock = at;
  const before = interims(msgs);
  upstream!.send(message);
  await waitUntil(() => interims(msgs) > before);
}

/** Sends UtteranceEnd at fake time `at` and returns the transcript_final. */
async function endUtterance(msgs: ServerAudioMessage[], at: number) {
  clock = at;
  upstream!.send(JSON.stringify({ type: "UtteranceEnd" }));
  await waitUntil(() => finals(msgs).length === 1);
  return finals(msgs)[0]!;
}

/**
 * Sends `count` 100 ms frames, frame i at fake time i * `everyMs`. Waits for
 * the first frame to be forwarded (upstream open) so the rest go straight
 * through instead of overflowing the pre-connect buffer.
 */
async function sendFrames(proxy: DeepgramProxy, count: number, everyMs: number): Promise<void> {
  clock = 0;
  proxy.sendAudio(FRAME);
  await waitUntil(() => upstream !== null && received >= FRAME.byteLength);
  for (let i = 1; i < count; i++) {
    clock = i * everyMs;
    proxy.sendAudio(FRAME);
  }
  await waitUntil(() => received >= count * FRAME.byteLength);
}

describe("STT recognition delay (live proxy, fake clock)", () => {
  beforeEach(() => {
    env.VOICE_MOCK = false;
    env.DEEPGRAM_LIVE = true;
    env.DEEPGRAM_API_KEY = "test-deepgram-key";
    clock = 0;
  });

  it("a 4 s utterance with a 200 ms recognition delay shows 200 ms, not ~4.2 s", async () => {
    const endpoint = await fakeDeepgram();
    const msgs: ServerAudioMessage[] = [];
    proxy = openLive(endpoint, msgs);

    // 4 s of speech in real time: frame i covers i*0.1 … i*0.1+0.1 s, arrives at i*100 ms.
    await sendFrames(proxy, 40, 100);

    // Last word ends at 3.95 s → frame 39, which arrived at 3900 ms.
    // Deepgram's final arrives 200 ms later.
    await sendFinal(
      msgs,
      4100,
      results("so I was thinking about tomorrow", true, [
        [0.1, 0.4],
        [3.6, 3.95],
      ]),
    );
    // UtteranceEnd follows after Deepgram's silence window.
    const final = await endUtterance(msgs, 4400);

    expect(final.latencyMs).toBe(200);
    // Whole-turn anchor: speech ended 4400 − 3900 ms before the final was sent.
    expect(final.sinceSpeechEndMs).toBe(500);
  });

  it("uses the last word of the last final segment of the utterance", async () => {
    const endpoint = await fakeDeepgram();
    const msgs: ServerAudioMessage[] = [];
    proxy = openLive(endpoint, msgs);

    // Frame i (i*0.1 s of audio) arrives at i*50 ms; frame 9 at 450 ms.
    await sendFrames(proxy, 10, 50);
    // First segment's last word (0.3 s → frame 3, 150 ms) must not be used.
    await sendFinal(msgs, 500, results("first part", true, [[0.0, 0.3]]));
    await sendFinal(msgs, 700, results("second part", true, [[0.5, 0.95]]));
    const final = await endUtterance(msgs, 700);

    expect(final.text).toBe("first part second part");
    expect(final.latencyMs).toBe(700 - 450);
    expect(final.sinceSpeechEndMs).toBe(700 - 450);
  });

  it("without word timings, measures from the last audio frame before the final", async () => {
    const endpoint = await fakeDeepgram();
    const msgs: ServerAudioMessage[] = [];
    proxy = openLive(endpoint, msgs);

    await sendFrames(proxy, 20, 50); // last frame at 950 ms
    await sendFinal(msgs, 1100, results("no timings", true));
    const final = await endUtterance(msgs, 1100);

    expect(final.latencyMs).toBe(150);
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
