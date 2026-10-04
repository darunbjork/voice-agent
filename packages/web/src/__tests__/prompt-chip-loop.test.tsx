import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientAudioMessage, ServerAudioMessage } from "@voice-agent/shared-types";
import { App } from "../App.js";

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.scrollIntoView = () => undefined;
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

vi.mock("../lib/feedback-tone.js", () => ({
  playFeedbackTone: vi.fn(),
}));

vi.mock("../hooks/useAudioCapture.js", () => ({
  useAudioCapture: () => ({
    status: "idle",
    error: null,
    level: 0,
    isCapturing: false,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock("../hooks/useTTSPlayer.js", () => {
  let isPlaying = false;
  return {
    useTTSPlayer: (options?: { onDone?: () => void }) => ({
      status: isPlaying ? "playing" : "idle",
      error: null,
      isPlaying,
      enqueue: async () => {
        isPlaying = true;
      },
      markDone: () => {
        isPlaying = false;
        options?.onDone?.();
      },
      cancel: () => {
        isPlaying = false;
      },
      prepare: () => {
        isPlaying = false;
      },
      getProgress: () => 1,
    }),
  };
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  binaryType = "arraybuffer";
  readyState = MockWebSocket.CONNECTING;
  sentPayloads: string[] = [];
  receivedFrames: ServerAudioMessage[] = [];

  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      this.sentPayloads.push(data);
      try {
        const parsed = JSON.parse(data) as ClientAudioMessage;
        if (parsed.type === "text_input") {
          this.simulateServerTurn(parsed.text);
        }
      } catch {
        // non-JSON
      }
    }
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "Normal closure" });
  }

  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(msg: ServerAudioMessage): void {
    this.receivedFrames.push(msg);
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  simulateServerTurn(text: string): void {
    this.emitMessage({ type: "session_id", sessionId: "sess-loop-test" });
    this.emitMessage({ type: "transcript_final", text, latencyMs: 42 });
    this.emitMessage({ type: "agent_thinking" });
    this.emitMessage({
      type: "agent_response",
      reply: {
        text: "It is 22°C and partly cloudy in Stockholm.",
        intent: "weather",
        card: {
          type: "weather",
          icon: "☀️",
          temp: "22°C",
          desc: "Partly cloudy",
          humidity: "55%",
          wind: "12 km/h",
          location: "Stockholm",
        },
        latencyMs: { stt: 42, llm: 1, tts: 0, total: 43 },
        sessionId: "sess-loop-test",
        turnIndex: 0,
      },
    });
    this.emitMessage({ type: "tts_done" });
  }
}

const originalWebSocket = globalThis.WebSocket;

describe("Empty-state prompt chip loop prevention", () => {
  beforeEach(() => {
    cleanup();
    MockWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  });

  it("clicking Weather chip once results in exactly ONE user bubble, ONE agent bubble, and no duplicate WS frames during a 2s wait", async () => {
    render(<App />);

    const weatherChip = screen.getByRole("button", { name: "Weather" });
    expect(weatherChip).toBeTruthy();

    act(() => {
      fireEvent.click(weatherChip);
    });

    expect(MockWebSocket.instances.length).toBe(1);
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("MockWebSocket instance was not created");

    act(() => {
      ws.triggerOpen();
    });

    const userBubbles = screen.getAllByText("What is the weather in Stockholm?");
    expect(userBubbles).toHaveLength(1);

    const agentBubbles = screen.getAllByText(/It is 22°C and partly cloudy/);
    expect(agentBubbles).toHaveLength(1);

    const initialAgentFrames = ws.receivedFrames.filter((f) => f.type === "agent_response").length;
    expect(initialAgentFrames).toBe(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    const userBubblesAfterWait = screen.getAllByText("What is the weather in Stockholm?");
    expect(userBubblesAfterWait).toHaveLength(1);

    const agentBubblesAfterWait = screen.getAllByText(/It is 22°C and partly cloudy/);
    expect(agentBubblesAfterWait).toHaveLength(1);

    const agentFramesAfterWait = ws.receivedFrames.filter(
      (f) => f.type === "agent_response",
    ).length;
    expect(agentFramesAfterWait).toBe(1);

    const sentTextInputFrames = ws.sentPayloads.filter((p) => {
      try {
        return (JSON.parse(p) as ClientAudioMessage).type === "text_input";
      } catch {
        return false;
      }
    });
    expect(sentTextInputFrames).toHaveLength(1);
  });

  it("idempotency guard prevents duplicate agent bubble if identical agent_response frame is received twice", async () => {
    render(<App />);

    const weatherChip = screen.getByRole("button", { name: "Weather" });
    act(() => {
      fireEvent.click(weatherChip);
    });

    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("MockWebSocket instance was not created");

    act(() => {
      ws.triggerOpen();
    });

    act(() => {
      ws.emitMessage({
        type: "agent_response",
        reply: {
          text: "It is 22°C and partly cloudy in Stockholm.",
          intent: "weather",
          card: null,
          latencyMs: { stt: 42, llm: 1, tts: 0, total: 43 },
          sessionId: "sess-loop-test",
          turnIndex: 0,
        },
      });
      ws.emitMessage({ type: "tts_done" });
      vi.advanceTimersByTime(2000);
    });

    const agentBubbles = screen.getAllByText((_content, element) => {
      return (
        element?.tagName === "DIV" &&
        Boolean(element.textContent?.startsWith("It is 22°C and partly cloudy")) &&
        element.parentElement?.style?.display === "flex"
      );
    });
    expect(agentBubbles).toHaveLength(1);
  });

  it("turn-in-flight guard prevents multiple text_input messages if clicked while a turn is in flight", async () => {
    render(<App />);

    const weatherChip = screen.getByRole("button", { name: "Weather" });
    act(() => {
      fireEvent.click(weatherChip);
      fireEvent.click(weatherChip);
    });

    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("MockWebSocket instance was not created");

    act(() => {
      ws.triggerOpen();
    });

    const textInputPayloads = ws.sentPayloads.filter((p) => p.includes("text_input"));
    expect(textInputPayloads).toHaveLength(1);
  });
});
