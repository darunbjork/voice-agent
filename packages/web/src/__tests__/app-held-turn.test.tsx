// C10b — live cold-start bug: "Hello" typed while the server was waking was
// sent after Ready and the reply was spoken, but its bubble showed only the
// GENERAL label, no text, until a second message was sent. This test runs the
// held path end to end with the real socket hook, the real TTS player (on a
// fake AudioContext) and the real word reveal, and checks the reply text.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientAudioMessage, ServerAudioMessage } from "@voice-agent/shared-types";
import { App } from "../App.js";

vi.mock("../lib/feedback-tone.js", () => ({ playFeedbackTone: vi.fn() }));
vi.mock("../hooks/useAudioCapture.js", () => ({
  useAudioCapture: () => ({
    status: "idle",
    error: null,
    isCapturing: false,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

const REPLY = "Hello there, how can I help you today?";

/** A source that ends when its audio would end on the context clock. */
class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  constructor(private ctx: FakeAudioContext) {}
  connect(): void {}
  disconnect(): void {}
  start(when = 0): void {
    if (FakeAudioContext.stalled) return; // never ends
    const endsInMs = (when + (this.buffer?.duration ?? 0) - this.ctx.currentTime) * 1000;
    setTimeout(() => this.onended?.(), Math.max(0, endsInMs));
  }
  stop(): void {}
}

/** The context clock follows wall time once running, as in a browser. */
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  /**
   * The player never learns that playback ended: the clock stands still and
   * no source fires onended (what a stuck reveal looks like from the inside).
   */
  static stalled = false;
  // A new context starts "suspended" in a browser; resume() takes a moment.
  state = "suspended";
  private startedAt: number | null = null;
  destination = {};
  sources = 0;
  constructor() {
    FakeAudioContext.last = this;
  }
  get currentTime(): number {
    if (FakeAudioContext.stalled) return 0;
    return this.startedAt === null ? 0 : (performance.now() - this.startedAt) / 1000;
  }
  createBuffer(_c: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  createBufferSource(): FakeSource {
    this.sources += 1;
    return new FakeSource(this);
  }
  createAnalyser() {
    return { fftSize: 32, connect() {}, disconnect() {}, getFloatTimeDomainData() {} };
  }
  async resume(): Promise<void> {
    await new Promise((r) => setTimeout(r, 30));
    this.state = "running";
    this.startedAt ??= performance.now();
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

/** One server turn for each text_input, in the order the API sends it. */
class ServerSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static last: ServerSocket | null = null;
  readyState = 0;
  binaryType = "arraybuffer";
  sent: ClientAudioMessage[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  constructor() {
    ServerSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.emit({ type: "session_id", sessionId: "sess-held" });
    }, 5);
  }
  emit(msg: ServerAudioMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    const msg = JSON.parse(data) as ClientAudioMessage;
    this.sent.push(msg);
    if (msg.type !== "text_input") return;
    const turn = this.sent.filter((m) => m.type === "text_input").length - 1;
    setTimeout(() => {
      this.emit({ type: "transcript_final", text: msg.text, latencyMs: 40 });
      this.emit({ type: "agent_thinking" });
      this.emit({
        type: "agent_response",
        reply: {
          text: turn === 0 ? REPLY : "Second reply.",
          intent: "general",
          card: null,
          latencyMs: { stt: 40, llm: 900, tts: 0, total: 940 },
          sessionId: "sess-held",
          turnIndex: turn,
        },
      });
      // Live shape (Fly log, "Hello" turn): 45 chunks, 12 odd-sized, all
      // within 0.38 s, for ~2.5 s of audio; tts_done right after the last.
      for (let i = 0; i < 45; i++) {
        setTimeout(
          () => {
            const bytes = 2667 + (i % 4 === 0 ? 1 : 0);
            const frame = new ArrayBuffer(4 + bytes);
            new DataView(frame).setUint32(0, i, false);
            this.onmessage?.({ data: frame });
            if (i === 44) this.emit({ type: "tts_done" });
          },
          Math.round((380 * i) / 44),
        );
      }
    }, 5);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

let answerHealth: (() => void) | null = null;

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  cleanup();
  FakeAudioContext.stalled = false;
  vi.stubGlobal("WebSocket", ServerSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown,
  );
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        answerHealth = () => resolve(new Response(JSON.stringify({ status: "ok" })));
      }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The agent bubble: the one with the intent label "general". */
function agentBubble(): HTMLElement | null {
  return screen.getByText(/^general$/i).parentElement;
}

/** The agent bubble's words that the reveal still hides (opacity 0). */
function hiddenWords(): string[] {
  const bubble = agentBubble();
  return Array.from(bubble?.querySelectorAll<HTMLElement>("span") ?? [])
    .filter((s) => s.style.opacity === "0")
    .map((s) => s.textContent ?? "");
}

function type(text: string): void {
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

/** Waits for the reply and for its ~2.5 s of audio to play out. */
async function replyFinishes(): Promise<void> {
  await waitFor(() => expect(screen.getByText(/^general$/i)).toBeTruthy());
  await waitFor(() => expect(FakeAudioContext.last?.sources).toBeGreaterThan(40), {
    timeout: 2000,
  });
  await act(() => new Promise((r) => setTimeout(r, 3000)));
}

describe("a message sent while waking gets its reply text", () => {
  it("held 'Hello' → Ready → reply: the text is shown, not only the label", async () => {
    render(<App />);
    act(() => type("Hello"));
    expect(screen.getByText(/Waiting for the server/)).toBeTruthy();

    await act(async () => answerHealth?.());
    await replyFinishes();

    expect(ServerSocket.last?.sent.filter((m) => m.type === "text_input")).toHaveLength(1);
    await waitFor(() => expect(hiddenWords()).toEqual([]));
    expect(agentBubble()?.textContent).toContain(REPLY);
  });

  it("the same turn sent after Ready (warm path) shows its text too", async () => {
    render(<App />);
    await act(async () => answerHealth?.());
    act(() => type("Hello"));
    await replyFinishes();
    await waitFor(() => expect(hiddenWords()).toEqual([]));
  });

  it("the turn's end reveals the text even if the player never reports playback done", async () => {
    // Whatever keeps the player from reporting the end (a late prepare(), a
    // stalled audio clock), the reply text must not stay hidden after the
    // turn: live it stayed hidden until the next message.
    FakeAudioContext.stalled = true;
    render(<App />);
    act(() => type("Hello"));
    await act(async () => answerHealth?.());
    await waitFor(() => expect(screen.getByText(/^general$/i)).toBeTruthy());
    await waitFor(() => expect(FakeAudioContext.last?.sources).toBeGreaterThan(40), {
      timeout: 2000,
    });
    expect(hiddenWords().length).toBeGreaterThan(0); // still revealing while audio "plays"

    // ~2.5 s of audio was scheduled after tts_done; then the text is shown.
    await waitFor(() => expect(hiddenWords()).toEqual([]), { timeout: 6000 });
    expect(agentBubble()?.textContent).toContain(REPLY);
  }, 10_000);
});
