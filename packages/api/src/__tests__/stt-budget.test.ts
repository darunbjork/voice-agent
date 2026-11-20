import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { ServerAudioMessage } from "@voice-agent/shared-types";
import { env } from "../env.js";
import { createDeepgramProxy, type DeepgramProxy } from "../modules/audio/deepgram.proxy.js";
import { getCircuitSnapshot, recordFailure, resetAllCircuits } from "../utils/circuit-breaker.js";
import { getDailyUsage, resetUsageMemory } from "../utils/usage-tracker.js";

const silentLogger = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as FastifyBaseLogger;

const saved = {
  voiceMock: env.VOICE_MOCK,
  deepgramLive: env.DEEPGRAM_LIVE,
  deepgramKey: env.DEEPGRAM_API_KEY,
  sttCap: env.DAILY_MAX_STT_SECONDS,
};

const PCM_BYTES_PER_SECOND = 32_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let server: Server | null = null;
let wss: WebSocketServer | null = null;
let proxy: DeepgramProxy | null = null;

beforeEach(() => {
  env.VOICE_MOCK = false;
  env.DEEPGRAM_LIVE = true;
  env.DEEPGRAM_API_KEY = "test-deepgram-key";
  resetAllCircuits();
  resetUsageMemory();
});

afterEach(async () => {
  proxy?.close();
  proxy = null;
  wss?.close();
  wss = null;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  env.VOICE_MOCK = saved.voiceMock;
  env.DEEPGRAM_LIVE = saved.deepgramLive;
  env.DEEPGRAM_API_KEY = saved.deepgramKey;
  env.DAILY_MAX_STT_SECONDS = saved.sttCap;
  vi.useRealTimers();
  resetAllCircuits();
  resetUsageMemory();
});

/** Fake Deepgram that rejects the WebSocket upgrade with `status`. */
async function rejectingServer(status: number): Promise<string> {
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (_req, socket) => {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

type FakeDeepgram = {
  url: string;
  received: () => number;
  /** Text (JSON) control messages received, e.g. KeepAlive. */
  texts: () => string[];
  /** Request path + query of the most recent upgrade. */
  lastPath: () => string;
  connections: () => number;
  /** Most recent upstream socket, server side. */
  last: () => ServerSocket | undefined;
};

/** Fake Deepgram that accepts connections and counts audio bytes it receives. */
async function acceptingServer(): Promise<FakeDeepgram> {
  let bytes = 0;
  let path = "";
  const texts: string[] = [];
  const sockets: ServerSocket[] = [];
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    sockets.push(ws);
    path = req.url ?? "";
    ws.on("message", (data, isBinary) => {
      if (isBinary) bytes += (data as Buffer).byteLength;
      else texts.push(data.toString());
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received: () => bytes,
    texts: () => texts,
    lastPath: () => path,
    connections: () => sockets.length,
    last: () => sockets.at(-1),
  };
}

function open(endpoint: string, sttSecondsUsedToday = 0): ServerAudioMessage[] {
  const msgs: ServerAudioMessage[] = [];
  proxy = createDeepgramProxy((m) => msgs.push(m), silentLogger, "stt-test", undefined, {
    endpoint,
    sttSecondsUsedToday,
  });
  return msgs;
}

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}

const errorCodes = (msgs: ServerAudioMessage[]): string[] =>
  msgs.flatMap((m) => (m.type === "error" ? [m.code] : []));

describe("STT daily seconds cap", () => {
  it("returns the text-input degraded proxy when today's seconds are already used up", () => {
    env.DAILY_MAX_STT_SECONDS = 3600;
    const msgs = open("ws://127.0.0.1:9", 3600);

    expect(proxy?.ready).toBe(false);
    expect(errorCodes(msgs)).toEqual(["stt_budget_exhausted"]);
    const err = msgs[0];
    expect(err?.type === "error" && err.message).toContain("Use text input");
  });

  it("a cap of 0 disables live STT", () => {
    env.DAILY_MAX_STT_SECONDS = 0;
    const msgs = open("ws://127.0.0.1:9", 0);
    expect(errorCodes(msgs)).toEqual(["stt_budget_exhausted"]);
  });

  it("cuts the session off mid-stream once the cap is reached and meters the seconds", async () => {
    env.DAILY_MAX_STT_SECONDS = 3;
    const fake = await acceptingServer();
    const msgs = open(fake.url, 1);
    const chunk = new ArrayBuffer(4096);
    proxy!.sendAudio(chunk);
    await waitUntil(() => fake.received() === 4096);

    // 2 seconds of budget left = 64_000 bytes; 20 more × 4096 overshoots.
    for (let i = 0; i < 20; i++) proxy!.sendAudio(chunk);
    await sleep(100);

    expect(errorCodes(msgs)).toEqual(["stt_budget_exhausted"]);
    expect(proxy!.ready).toBe(false);
    expect(fake.received()).toBeLessThanOrEqual(2 * PCM_BYTES_PER_SECOND);
    expect(fake.received()).toBeGreaterThan(0);
    expect((await getDailyUsage()).sttSeconds).toBe(2);
  });

  it("meters forwarded audio into the daily usage on close", async () => {
    env.DAILY_MAX_STT_SECONDS = 3600;
    const fake = await acceptingServer();
    open(fake.url, 0);

    // 1.5 s of audio → rounded up to 2 billable seconds.
    const chunk = new ArrayBuffer(4000);
    for (let i = 0; i < 12; i++) proxy!.sendAudio(chunk);
    await waitUntil(() => fake.received() === 48_000);
    proxy!.close();
    await sleep(20);

    expect((await getDailyUsage()).sttSeconds).toBe(2);
  });
});

describe("Deepgram STT handshake rejections", () => {
  it.each([402, 429])(
    "%i → stt_budget_exhausted (text input) without counting a breaker failure",
    async (code) => {
      const msgs = open(await rejectingServer(code));
      proxy!.sendAudio(new ArrayBuffer(320));
      await waitUntil(() => msgs.length > 0);
      await sleep(50);

      expect(errorCodes(msgs)).toEqual(["stt_budget_exhausted"]);
      expect(getCircuitSnapshot("deepgram").failures).toBe(0);
      expect(proxy!.ready).toBe(false);
    },
  );

  it("other rejections (500) report deepgram_error and count one breaker failure", async () => {
    const msgs = open(await rejectingServer(500));
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => msgs.length > 0);
    await sleep(50);

    expect(errorCodes(msgs)).toEqual(["deepgram_error"]);
    const err = msgs[0];
    expect(err?.type === "error" && err.message).toContain("500");
    expect(getCircuitSnapshot("deepgram").failures).toBe(1);
  });

  it("402/429 stop reconnect attempts for the rest of the session", async () => {
    const msgs = open(await rejectingServer(402));
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => msgs.length > 0);
    proxy!.sendAudio(new ArrayBuffer(320));
    await sleep(50);
    expect(errorCodes(msgs)).toEqual(["stt_budget_exhausted"]);
  });

  it("closing while still connecting does not report an error", async () => {
    const fake = await acceptingServer();
    const msgs = open(fake.url);
    proxy!.sendAudio(new ArrayBuffer(320));
    proxy!.close();
    await sleep(100);

    expect(errorCodes(msgs)).toEqual([]);
    expect(getCircuitSnapshot("deepgram").failures).toBe(0);
  });
});

describe("lazy connect and idle reconnect", () => {
  it("does not open Deepgram until the first audio frame arrives", async () => {
    const fake = await acceptingServer();
    open(fake.url);
    await sleep(100);
    expect(fake.connections()).toBe(0);
    expect(proxy!.ready).toBe(true);

    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => fake.connections() === 1);
  });

  it("delivers audio sent while the connection is still opening", async () => {
    const fake = await acceptingServer();
    open(fake.url);
    for (let i = 0; i < 5; i++) proxy!.sendAudio(new ArrayBuffer(1000));
    await waitUntil(() => fake.received() === 5000);
    expect(fake.connections()).toBe(1);
  });

  it("caps the pre-connect buffer at ~3 s by dropping the oldest audio", async () => {
    const fake = await acceptingServer();
    open(fake.url);
    // 5 s of audio queued before the socket can open.
    for (let i = 0; i < 40; i++) proxy!.sendAudio(new ArrayBuffer(4000));
    await waitUntil(() => fake.received() > 0);
    await sleep(50);
    expect(fake.received()).toBe(3 * PCM_BYTES_PER_SECOND);
  });

  it("reconnects when audio arrives after Deepgram closed an idle stream, without a breaker failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = await acceptingServer();
    const msgs = open(fake.url);
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => fake.received() === 320);

    // Mic off for >10 s: Deepgram times the stream out (NET-0001, code 1011).
    vi.setSystemTime(Date.now() + 12_000);
    fake.last()!.close(1011, "NET-0001");
    await sleep(50);
    expect(getCircuitSnapshot("deepgram").failures).toBe(0);

    proxy!.sendAudio(new ArrayBuffer(640));
    await waitUntil(() => fake.received() === 960);
    expect(fake.connections()).toBe(2);
    expect(errorCodes(msgs)).toEqual([]);
  });

  it("counts a drop while audio is flowing as a failure and backs off before reconnecting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = await acceptingServer();
    open(fake.url);
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => fake.received() === 320);

    fake.last()!.close(1011, "internal error");
    await sleep(50);
    expect(getCircuitSnapshot("deepgram").failures).toBe(1);

    proxy!.sendAudio(new ArrayBuffer(320));
    await sleep(50);
    expect(fake.connections()).toBe(1);

    vi.setSystemTime(Date.now() + 2_500);
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => fake.connections() === 2);
  });

  it("reports deepgram_circuit_open once and does not reconnect while the breaker is open", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = await acceptingServer();
    const msgs = open(fake.url);
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => fake.received() === 320);

    vi.setSystemTime(Date.now() + 12_000);
    fake.last()!.close(1011, "NET-0001");
    await sleep(50);
    for (let i = 0; i < 5; i++) recordFailure("deepgram");

    proxy!.sendAudio(new ArrayBuffer(320));
    proxy!.sendAudio(new ArrayBuffer(320));
    await sleep(50);
    expect(fake.connections()).toBe(1);
    expect(errorCodes(msgs)).toEqual(["deepgram_circuit_open"]);
  });
});

describe("KeepAlive while the mic is paused", () => {
  const keepAlives = (fake: FakeDeepgram): number =>
    fake.texts().filter((t) => t.includes('"KeepAlive"')).length;

  it("sends KeepAlive after ~5 s without audio, and not while audio flows", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fake = await acceptingServer();
    open(fake.url);
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => fake.received() === 320);

    // Audio every second for 6 s → no KeepAlive needed.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(1000);
      proxy!.sendAudio(new ArrayBuffer(320));
    }
    await sleep(30);
    expect(keepAlives(fake)).toBe(0);

    // Mic paused for 12 s → KeepAlive roughly every 5 s.
    vi.advanceTimersByTime(12_000);
    await waitUntil(() => keepAlives(fake) === 2);
    expect(JSON.parse(fake.texts()[0]!)).toEqual({ type: "KeepAlive" });
  });

  it("stops keeping an unused stream alive after 60 s idle", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const fake = await acceptingServer();
    open(fake.url);
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => fake.received() === 320);

    vi.advanceTimersByTime(60_000);
    await sleep(30);
    const atLimit = keepAlives(fake);
    expect(atLimit).toBeGreaterThanOrEqual(10);

    vi.advanceTimersByTime(30_000);
    await sleep(30);
    expect(keepAlives(fake)).toBe(atLimit);
  });
});

describe("utterance assembly", () => {
  const results = (transcript: string, isFinal: boolean, speechFinal = false): string =>
    JSON.stringify({
      type: "Results",
      is_final: isFinal,
      speech_final: speechFinal,
      channel: { alternatives: [{ transcript }] },
    });

  async function connected(): Promise<{ fake: FakeDeepgram; msgs: ServerAudioMessage[] }> {
    const fake = await acceptingServer();
    const msgs = open(fake.url);
    proxy!.sendAudio(new ArrayBuffer(320));
    await waitUntil(() => fake.received() === 320);
    return { fake, msgs };
  }

  const finals = (msgs: ServerAudioMessage[]): string[] =>
    msgs.flatMap((m) => (m.type === "transcript_final" ? [m.text] : []));
  const interims = (msgs: ServerAudioMessage[]): string[] =>
    msgs.flatMap((m) => (m.type === "transcript_interim" ? [m.text] : []));

  it("asks Deepgram for UtteranceEnd after 1 s (utterance_end_ms=1000, vad_events) and keeps endpointing", async () => {
    const { fake } = await connected();
    const q = new URL(fake.lastPath(), "ws://x").searchParams;
    expect(q.get("utterance_end_ms")).toBe("1000");
    expect(q.get("vad_events")).toBe("true");
    expect(q.get("interim_results")).toBe("true");
    expect(q.get("endpointing")).toBe("500");
  });

  it("joins finalised segments split by a pause into one turn on UtteranceEnd", async () => {
    const { fake, msgs } = await connected();
    const dg = fake.last()!;
    dg.send(results("What does goodnight mean", true, true));
    dg.send(results("in", false));
    dg.send(results("in Swedish?", true, true));
    await sleep(50);
    expect(finals(msgs)).toEqual([]);
    expect(interims(msgs)).toEqual([
      "What does goodnight mean",
      "What does goodnight mean in",
      "What does goodnight mean in Swedish?",
    ]);

    dg.send(JSON.stringify({ type: "UtteranceEnd", last_word_end: 3.1 }));
    await waitUntil(() => finals(msgs).length === 1);
    expect(finals(msgs)).toEqual(["What does goodnight mean in Swedish?"]);
  });

  it("starts a fresh utterance after each UtteranceEnd", async () => {
    const { fake, msgs } = await connected();
    const dg = fake.last()!;
    dg.send(results("Hello", true));
    dg.send(JSON.stringify({ type: "UtteranceEnd" }));
    dg.send(results("How are you?", true));
    dg.send(JSON.stringify({ type: "UtteranceEnd" }));
    await waitUntil(() => finals(msgs).length === 2);
    expect(finals(msgs)).toEqual(["Hello", "How are you?"]);
  });

  it("ignores UtteranceEnd with nothing finalised", async () => {
    const { fake, msgs } = await connected();
    fake.last()!.send(JSON.stringify({ type: "UtteranceEnd" }));
    await sleep(50);
    expect(finals(msgs)).toEqual([]);
  });

  it("emits pending segments if UtteranceEnd never arrives", async () => {
    const { fake, msgs } = await connected();
    fake.last()!.send(results("What time is it", true, true));
    await sleep(1500);
    expect(finals(msgs)).toEqual([]);
    await waitUntil(() => finals(msgs).length === 1, 2000);
    expect(finals(msgs)).toEqual(["What time is it"]);
  });

  it("emits pending segments when Deepgram closes the stream", async () => {
    const { fake, msgs } = await connected();
    fake.last()!.send(results("Remind me to call mum", true));
    await sleep(30);
    fake.last()!.close(1000);
    await waitUntil(() => finals(msgs).length === 1);
    expect(finals(msgs)).toEqual(["Remind me to call mum"]);
  });

  it("drops pending segments when the client ends the session", async () => {
    const { fake, msgs } = await connected();
    fake.last()!.send(results("half a sentence", true));
    await sleep(30);
    proxy!.close();
    await sleep(2200);
    expect(finals(msgs)).toEqual([]);
  });
});
