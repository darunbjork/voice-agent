import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { ServerAudioMessage } from "@voice-agent/shared-types";
import { env } from "../env.js";
import { createDeepgramProxy, type DeepgramProxy } from "../modules/audio/deepgram.proxy.js";
import { getCircuitSnapshot, resetAllCircuits } from "../utils/circuit-breaker.js";
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

/** Fake Deepgram that accepts the connection and counts audio bytes it receives. */
async function acceptingServer(): Promise<{ url: string; received: () => number }> {
  let bytes = 0;
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) bytes += (data as Buffer).byteLength;
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received: () => bytes,
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
    await waitUntil(() => proxy?.ready === true);

    // 2 seconds of budget left = 64_000 bytes; send 20 × 4096 = 81_920.
    const chunk = new ArrayBuffer(4096);
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
    await waitUntil(() => proxy?.ready === true);

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
      await waitUntil(() => msgs.length > 0);
      await sleep(50);

      expect(errorCodes(msgs)).toEqual(["stt_budget_exhausted"]);
      expect(getCircuitSnapshot("deepgram").failures).toBe(0);
      expect(proxy!.ready).toBe(false);
    },
  );

  it("other rejections (500) report deepgram_error and count one breaker failure", async () => {
    const msgs = open(await rejectingServer(500));
    await waitUntil(() => msgs.length > 0);
    await sleep(50);

    expect(errorCodes(msgs)).toEqual(["deepgram_error"]);
    const err = msgs[0];
    expect(err?.type === "error" && err.message).toContain("500");
    expect(getCircuitSnapshot("deepgram").failures).toBe(1);
  });

  it("closing while still connecting does not report an error", async () => {
    const fake = await acceptingServer();
    const msgs = open(fake.url);
    proxy!.close();
    await sleep(100);

    expect(errorCodes(msgs)).toEqual([]);
    expect(getCircuitSnapshot("deepgram").failures).toBe(0);
  });
});
