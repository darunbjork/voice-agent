import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { turnLimits, mergeTranscripts } from "../modules/audio/audio.routes.js";

// Controllable agent: each test decides how long a turn takes or whether it hangs.
const { handleUtteranceMock } = vi.hoisted(() => ({ handleUtteranceMock: vi.fn() }));
vi.mock("../modules/agent/agent.service.js", () => ({ handleUtterance: handleUtteranceMock }));

// Pass-through spy on control messages: lets a test wait until the server has
// actually handled barge_in (it sends nothing back for it).
const { controlSpy } = vi.hoisted(() => ({ controlSpy: vi.fn() }));
vi.mock("../modules/audio/deepgram.proxy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../modules/audio/deepgram.proxy.js")>();
  return {
    ...actual,
    handleControlMessage: (...args: Parameters<typeof actual.handleControlMessage>) => {
      controlSpy(args[0]);
      return actual.handleControlMessage(...args);
    },
  };
});

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

/** Polls until `cond` holds. Fails with `what` if it never does (no fixed sleeps). */
async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(5);
  }
}

/**
 * Agent mock for split-utterance tests: fragments hang until the server
 * cancels them (deterministic, unlike a fixed agent delay); the full text
 * answers at once. `ignoreAbort` makes a cancelled fragment still return a reply.
 */
const fragmentsHang =
  (full: string, seen: string[] = [], ignoreAbort = false) =>
  async (input: { text: string; signal?: AbortSignal }) => {
    seen.push(input.text);
    if (input.text === full) return reply(input.text);
    await new Promise<void>((resolve) => {
      if (input.signal?.aborted) resolve();
      input.signal?.addEventListener("abort", () => resolve());
    });
    if (ignoreAbort) return reply(`answer to: ${input.text}`);
    throw new Error("aborted");
  };

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
    controlSpy.mockClear();
  });
  afterEach(() => {
    Object.assign(turnLimits, savedLimits);
  });

  const replies = (msgs: Msg[]) =>
    msgs.filter((m) => m.type === "agent_response").map((m) => m.reply?.text);
  const errors = (msgs: Msg[]) => msgs.filter((m) => m.type === "error").map((m) => m.code);
  const agentCalls = () => handleUtteranceMock.mock.calls.length;

  /**
   * Barrier instead of a "grace" sleep: once every agent call has settled, any
   * reply it causes is written before the server reads our next frame. So we
   * send a frame the server rejects at once (invalid_message) and wait for that
   * rejection: a duplicate reply, if any, has arrived before it. The barrier's
   * own error is removed from `msgs`.
   */
  async function barrier(ws: WebSocket, msgs: Msg[]): Promise<void> {
    await Promise.allSettled(handleUtteranceMock.mock.results.map((r) => r.value as unknown));
    const from = msgs.length;
    const isBarrier = (m: Msg, i: number) =>
      i >= from && m.type === "error" && m.code === "invalid_message";
    ws.send("barrier: not JSON");
    await until(() => msgs.some(isBarrier), "barrier rejection");
    msgs.splice(msgs.findIndex(isBarrier), 1);
  }

  /**
   * Opens a session, runs `script`, waits until `done(msgs)` holds, then a
   * barrier so a duplicate reply would still be seen. Every step waits for an
   * event, never for a guessed time.
   */
  async function session(
    script: (ws: WebSocket, msgs: Msg[]) => Promise<void> | void,
    done: (msgs: Msg[]) => boolean,
  ): Promise<Msg[]> {
    const msgs: Msg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/audio`, {
      headers: { Origin: "http://localhost:5173" },
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) msgs.push(JSON.parse(data.toString()) as Msg);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    try {
      await script(ws, msgs);
      await until(() => done(msgs), "the expected reply/error");
      await barrier(ws, msgs);
    } finally {
      ws.close();
    }
    return msgs;
  }

  const ask = (ws: WebSocket, text: string) =>
    ws.send(JSON.stringify({ type: "text_input", text }));
  const answered = (msgs: Msg[]) =>
    msgs.some((m) => m.type === "agent_response" || m.type === "error");

  it("a turn that hangs ends with a visible turn_timeout error", async () => {
    turnLimits.timeoutMs = 150;
    handleUtteranceMock.mockImplementation(hangUntilAborted);

    const msgs = await session((ws) => ask(ws, "What is agentic AI?"), answered);

    expect(replies(msgs)).toEqual([]);
    expect(errors(msgs)).toEqual(["turn_timeout"]);
  });

  it("an agent crash ends with a visible error", async () => {
    handleUtteranceMock.mockRejectedValue(new Error("boom"));
    const msgs = await session((ws) => ask(ws, "How are you?"), answered);
    expect(errors(msgs)).toEqual(["agent_turn_failed"]);
  });

  it("barge-in while thinking stops speech but keeps the pending reply", async () => {
    let release = (): void => undefined;
    handleUtteranceMock.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return reply("kept");
    });
    const msgs = await session(async (ws) => {
      ask(ws, "What is the main difference between agentic AI and RAG?");
      await until(() => agentCalls() === 1, "agent called");
      ws.send(JSON.stringify({ type: "barge_in" }));
      await until(
        () => controlSpy.mock.calls.some(([m]) => (m as Msg).type === "barge_in"),
        "server handled barge_in",
      );
      release();
    }, answered);
    expect(replies(msgs)).toEqual(["kept"]);
  });

  // ── Split utterances (live: "Can I build" / "an animation video?" got two replies) ──

  it("a continuation before the reply cancels it and answers the merged text once", async () => {
    const full = "Can I build an animation video?";
    const seen: string[] = [];
    handleUtteranceMock.mockImplementation(fragmentsHang(full, seen));

    const msgs = await session(async (ws) => {
      ask(ws, "Can I build");
      await until(() => agentCalls() === 1, "fragment reached the agent");
      ask(ws, "an animation video?");
    }, answered);

    expect(seen).toEqual(["Can I build", full]);
    expect(replies(msgs)).toEqual([full]);
    expect(errors(msgs)).toEqual([]);
  });

  it("the cancelled reply is suppressed even if the agent ignores the abort", async () => {
    const full = "Which language is more into tech?";
    handleUtteranceMock.mockImplementation(fragmentsHang(full, [], true));

    const msgs = await session(async (ws) => {
      ask(ws, "Which language is more");
      await until(() => agentCalls() === 1, "fragment reached the agent");
      ask(ws, "into tech?");
    }, answered);

    expect(replies(msgs)).toEqual([full]);
  });

  it.each([
    ["Can I build", "an animation video?"],
    ["Which language is more", "into tech?"],
    ["What kind of app would attract", "users, developers,"],
  ])("live split %s / %s → one merged reply", async (first, second) => {
    handleUtteranceMock.mockImplementation(fragmentsHang(`${first} ${second}`));
    const msgs = await session(async (ws) => {
      ask(ws, first);
      await until(() => agentCalls() === 1, "fragment reached the agent");
      ask(ws, second);
    }, answered);
    expect(replies(msgs)).toEqual([`${first} ${second}`]);
  });

  it("three fragments become one turn", async () => {
    const full = "What kind of app would attract users, developers,";
    const seen: string[] = [];
    handleUtteranceMock.mockImplementation(fragmentsHang(full, seen));

    const msgs = await session(async (ws) => {
      ask(ws, "What kind of app would");
      await until(() => agentCalls() === 1, "first fragment reached the agent");
      ask(ws, "attract");
      await until(() => agentCalls() === 2, "merged fragment reached the agent");
      ask(ws, "users, developers,");
    }, answered);

    expect(replies(msgs)).toEqual([full]);
    expect(seen).toEqual(["What kind of app would", "What kind of app would attract", full]);
  });

  it("after a reply was delivered, the next utterance is a new question", async () => {
    handleUtteranceMock.mockImplementation(async (input: { text: string }) =>
      reply(`answer to: ${input.text}`),
    );

    const msgs = await session(
      async (ws, live) => {
        ask(ws, "What is RAG?");
        await until(() => replies(live).length === 1, "first reply");
        ask(ws, "And what is MCP?");
      },
      (m) => replies(m).length === 2,
    );

    expect(replies(msgs)).toEqual(["answer to: What is RAG?", "answer to: And what is MCP?"]);
  });

  it("a timed-out turn still shows an error, and the next question runs", async () => {
    turnLimits.timeoutMs = 150;
    handleUtteranceMock
      .mockImplementationOnce(hangUntilAborted)
      .mockImplementationOnce(async () => reply("second answer"));

    const msgs = await session(
      async (ws, live) => {
        ask(ws, "first");
        // Wait for the timeout itself; a fixed sleep let "second" arrive first
        // on slow CI, so it was merged into the hanging turn (no error sent).
        await until(() => errors(live).length === 1, "turn_timeout error");
        ask(ws, "second");
      },
      (m) => replies(m).length === 1,
    );

    expect(errors(msgs)).toEqual(["turn_timeout"]);
    expect(replies(msgs)).toEqual(["second answer"]);
  });

  it("a reply whose speech cannot start still ends with tts_done (C9)", async () => {
    // Over the 600-character TTS cap: streamTts throws before any audio.
    handleUtteranceMock.mockImplementation(async () => reply("x".repeat(700)));
    const msgs = await session(
      (ws) => ask(ws, "Tell me everything"),
      (m) => m.some((x) => x.type === "tts_done"),
    );
    expect(replies(msgs)).toHaveLength(1);
    const types = msgs.map((m) => m.type);
    expect(types.indexOf("tts_done")).toBeGreaterThan(types.indexOf("agent_response"));
  });

  it("mergeTranscripts joins text and keeps the latest latency", () => {
    expect(
      mergeTranscripts(
        { type: "transcript_final", text: " Can I build ", latencyMs: 10 },
        { type: "transcript_final", text: "an animation video?", latencyMs: 20 },
      ),
    ).toEqual({ type: "transcript_final", text: "Can I build an animation video?", latencyMs: 20 });
  });
});
