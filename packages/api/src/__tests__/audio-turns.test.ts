import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { turnLimits } from "../modules/audio/audio.routes.js";

// Controllable agent: each test decides how long a turn takes or whether it hangs.
const { handleUtteranceMock } = vi.hoisted(() => ({ handleUtteranceMock: vi.fn() }));
vi.mock("../modules/agent/agent.service.js", () => ({ handleUtterance: handleUtteranceMock }));

type Msg = { type: string; code?: string; reply?: { text: string } };

const reply = (text: string) => ({
  reply: {
    text,
    intent: "general",
    card: null,
    latencyMs: { stt: 0, llm: 1, tts: 0, total: 1 },
    sessionId: "s",
    turnIndex: 0,
  },
  viaFastPath: false,
  pipelineMs: 1,
});

/** Never settles on its own; rejects when the turn signal aborts. */
const hangUntilAborted = (input: { signal?: AbortSignal }) =>
  new Promise((_, reject) => {
    input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("audio WebSocket turns always end in a reply or a visible error", () => {
  let app: FastifyInstance;
  let port: number;
  const savedLimits = { ...turnLimits };

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    handleUtteranceMock.mockReset();
  });
  afterEach(() => {
    Object.assign(turnLimits, savedLimits);
  });

  /** Opens a session, sends the given client messages, collects JSON messages for `ms`. */
  async function session(
    send: (ws: WebSocket) => Promise<void> | void,
    ms: number,
  ): Promise<Msg[]> {
    const msgs: Msg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/audio`);
    ws.on("message", (data, isBinary) => {
      if (!isBinary) msgs.push(JSON.parse(data.toString()) as Msg);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await send(ws);
    await sleep(ms);
    ws.close();
    return msgs;
  }

  const ask = (ws: WebSocket, text: string) =>
    ws.send(JSON.stringify({ type: "text_input", text }));
  const replies = (msgs: Msg[]) =>
    msgs.filter((m) => m.type === "agent_response").map((m) => m.reply?.text);
  const errors = (msgs: Msg[]) => msgs.filter((m) => m.type === "error").map((m) => m.code);

  it("a second question while the first is still thinking no longer drops the first", async () => {
    handleUtteranceMock.mockImplementation(async (input: { text: string }) => {
      await sleep(input.text.startsWith("slow") ? 300 : 10);
      return reply(`answer to ${input.text}`);
    });

    const msgs = await session(async (ws) => {
      ask(ws, "slow: What does RAG stand for?");
      await sleep(50);
      ask(ws, "fast: What's MCP?");
    }, 700);

    expect(replies(msgs)).toEqual([
      "answer to slow: What does RAG stand for?",
      "answer to fast: What's MCP?",
    ]);
    expect(errors(msgs)).toEqual([]);
  });

  it("a turn that hangs ends with a visible turn_timeout error", async () => {
    turnLimits.timeoutMs = 150;
    handleUtteranceMock.mockImplementation(hangUntilAborted);

    const msgs = await session((ws) => ask(ws, "What is agentic AI?"), 400);

    expect(replies(msgs)).toEqual([]);
    expect(errors(msgs)).toEqual(["turn_timeout"]);
  });

  it("the next queued question still runs after a timed-out one", async () => {
    turnLimits.timeoutMs = 150;
    handleUtteranceMock
      .mockImplementationOnce(hangUntilAborted)
      .mockImplementationOnce(async () => reply("second answer"));

    const msgs = await session(async (ws) => {
      ask(ws, "first");
      await sleep(20);
      ask(ws, "second");
    }, 500);

    expect(errors(msgs)).toEqual(["turn_timeout"]);
    expect(replies(msgs)).toEqual(["second answer"]);
  });

  it("an agent crash ends with a visible error", async () => {
    handleUtteranceMock.mockRejectedValue(new Error("boom"));
    const msgs = await session((ws) => ask(ws, "How are you?"), 200);
    expect(errors(msgs)).toEqual(["agent_turn_failed"]);
  });

  it("barge-in while thinking stops speech but keeps the pending reply", async () => {
    handleUtteranceMock.mockImplementation(async () => {
      await sleep(150);
      return reply("kept");
    });
    const msgs = await session(async (ws) => {
      ask(ws, "What is the main difference between agentic AI and RAG?");
      await sleep(30);
      ws.send(JSON.stringify({ type: "barge_in" }));
    }, 400);
    expect(replies(msgs)).toEqual(["kept"]);
  });

  it("refuses visibly once too many questions are waiting", async () => {
    turnLimits.maxQueued = 1;
    handleUtteranceMock.mockImplementation(async (input: { text: string }) => {
      await sleep(150);
      return reply(input.text);
    });
    const msgs = await session((ws) => {
      ask(ws, "one");
      ask(ws, "two");
      ask(ws, "three");
    }, 600);
    expect(replies(msgs)).toEqual(["one", "two"]);
    expect(errors(msgs)).toEqual(["turn_queue_full"]);
  });
});
