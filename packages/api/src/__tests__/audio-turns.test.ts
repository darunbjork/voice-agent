import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { turnLimits, mergeTranscripts } from "../modules/audio/audio.routes.js";

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

  it("a turn that hangs ends with a visible turn_timeout error", async () => {
    turnLimits.timeoutMs = 150;
    handleUtteranceMock.mockImplementation(hangUntilAborted);

    const msgs = await session((ws) => ask(ws, "What is agentic AI?"), 400);

    expect(replies(msgs)).toEqual([]);
    expect(errors(msgs)).toEqual(["turn_timeout"]);
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

  // ── Split utterances (live: "Can I build" / "an animation video?" got two replies) ──

  it("a continuation before the reply cancels it and answers the merged text once", async () => {
    const seen: string[] = [];
    handleUtteranceMock.mockImplementation(
      async (input: { text: string; signal?: AbortSignal }) => {
        seen.push(input.text);
        await sleep(200);
        if (input.signal?.aborted) throw new Error("aborted");
        return reply(`answer to: ${input.text}`);
      },
    );

    const msgs = await session(async (ws) => {
      ask(ws, "Can I build");
      await sleep(60);
      ask(ws, "an animation video?");
    }, 700);

    // The fragment may be cancelled before or after it reached the agent.
    expect(seen.at(-1)).toBe("Can I build an animation video?");
    expect(seen.every((t) => t === "Can I build" || t === "Can I build an animation video?")).toBe(
      true,
    );
    expect(replies(msgs)).toEqual(["answer to: Can I build an animation video?"]);
    expect(errors(msgs)).toEqual([]);
  });

  it("the cancelled reply is suppressed even if the agent ignores the abort", async () => {
    handleUtteranceMock.mockImplementation(async (input: { text: string }) => {
      await sleep(input.text === "Which language is more" ? 200 : 20);
      return reply(`answer to: ${input.text}`);
    });

    const msgs = await session(async (ws) => {
      ask(ws, "Which language is more");
      await sleep(50);
      ask(ws, "into tech?");
    }, 600);

    expect(replies(msgs)).toEqual(["answer to: Which language is more into tech?"]);
  });

  it.each([
    ["Can I build", "an animation video?"],
    ["Which language is more", "into tech?"],
    ["What kind of app would attract", "users, developers,"],
  ])("live split %s / %s → one merged reply", async (first, second) => {
    handleUtteranceMock.mockImplementation(
      async (input: { text: string; signal?: AbortSignal }) => {
        await sleep(150);
        if (input.signal?.aborted) throw new Error("aborted");
        return reply(input.text);
      },
    );
    const msgs = await session(async (ws) => {
      ask(ws, first);
      await sleep(40);
      ask(ws, second);
    }, 600);
    expect(replies(msgs)).toEqual([`${first} ${second}`]);
  });

  it("three fragments become one turn", async () => {
    const seen: string[] = [];
    handleUtteranceMock.mockImplementation(
      async (input: { text: string; signal?: AbortSignal }) => {
        seen.push(input.text);
        await sleep(150);
        if (input.signal?.aborted) throw new Error("aborted");
        return reply(input.text);
      },
    );

    const msgs = await session(async (ws) => {
      ask(ws, "What kind of app would");
      await sleep(40);
      ask(ws, "attract");
      await sleep(40);
      ask(ws, "users, developers,");
    }, 700);

    expect(replies(msgs)).toEqual(["What kind of app would attract users, developers,"]);
    expect(seen.at(-1)).toBe("What kind of app would attract users, developers,");
  });

  it("after a reply was delivered, the next utterance is a new question", async () => {
    handleUtteranceMock.mockImplementation(async (input: { text: string }) => {
      await sleep(20);
      return reply(`answer to: ${input.text}`);
    });

    const msgs = await session(async (ws) => {
      ask(ws, "What is RAG?");
      await sleep(150);
      ask(ws, "And what is MCP?");
    }, 400);

    expect(replies(msgs)).toEqual(["answer to: What is RAG?", "answer to: And what is MCP?"]);
  });

  it("a timed-out turn still shows an error, and the next question runs", async () => {
    turnLimits.timeoutMs = 150;
    handleUtteranceMock
      .mockImplementationOnce(hangUntilAborted)
      .mockImplementationOnce(async () => reply("second answer"));

    const msgs = await session(async (ws) => {
      ask(ws, "first");
      await sleep(250);
      ask(ws, "second");
    }, 450);

    expect(errors(msgs)).toEqual(["turn_timeout"]);
    expect(replies(msgs)).toEqual(["second answer"]);
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
