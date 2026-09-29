import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReply, ClientAudioMessage } from "@voice-agent/shared-types";
import { App } from "../App.js";
import type { CaptureStatus } from "../hooks/useAudioCapture.js";
import type { TranscriptHandlers } from "../hooks/useDeepgramProxy.js";

const ctl = vi.hoisted(() => ({
  handlers: null as TranscriptHandlers | null,
  sent: [] as ClientAudioMessage[],
  proxyStatus: "connected",
  lastError: null as string | null,
  sessionId: null as string | null,
  onRms: null as ((rms: number) => void) | null,
  setCaptureStatus: null as ((status: CaptureStatus) => void) | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("../lib/feedback-tone.js", () => ({
  playFeedbackTone: vi.fn(),
}));

vi.mock("../hooks/useDeepgramProxy.js", () => ({
  useDeepgramProxy: (options: { handlers: TranscriptHandlers }) => {
    ctl.handlers = options.handlers;
    return {
      status: ctl.proxyStatus,
      sessionId: ctl.sessionId,
      lastError: ctl.lastError,
      connect: ctl.connect,
      disconnect: ctl.disconnect,
      sendAudio: () => undefined,
      sendMessage: (msg: ClientAudioMessage) => {
        ctl.sent.push(msg);
      },
      isConnected: ctl.proxyStatus === "connected",
    };
  },
}));

vi.mock("../hooks/useAudioCapture.js", async () => {
  const { useState } = await import("react");
  return {
    useAudioCapture: (options: { onRms: (rms: number) => void }) => {
      const [status, setStatus] = useState<CaptureStatus>("idle");
      ctl.setCaptureStatus = setStatus;
      ctl.onRms = options.onRms;
      return {
        status,
        error: null,
        isCapturing: status === "capturing",
        start: async () => {
          setStatus("capturing");
        },
        stop: () => {
          setStatus("idle");
        },
      };
    },
  };
});

vi.mock("../hooks/useTTSPlayer.js", async () => {
  const { useState } = await import("react");
  return {
    useTTSPlayer: () => {
      const [playing, setPlaying] = useState(false);
      return {
        status: playing ? "playing" : "idle",
        error: null,
        isPlaying: playing,
        enqueue: async () => {
          setPlaying(true);
        },
        markDone: () => {
          setPlaying(false);
        },
        cancel: () => {
          setPlaying(false);
        },
        prepare: () => {
          setPlaying(false);
        },
      };
    },
  };
});

function status(): string {
  return document.querySelector(".status-value")?.textContent ?? "";
}

function handlers(): TranscriptHandlers {
  const captured = ctl.handlers;
  if (!captured) throw new Error("proxy handlers were not captured");
  return captured;
}

function makeReply(): AgentReply {
  return {
    text: "Here is the answer.",
    intent: "fallback",
    card: null,
    latencyMs: { stt: 120, llm: 240, tts: 0, total: 360 },
    sessionId: "sess-test",
    turnIndex: 1,
  };
}

async function pressMic(): Promise<void> {
  const mic = screen.getByRole("button", { name: "Start microphone" });
  await act(async () => {
    fireEvent.keyDown(mic, { key: "Enter" });
  });
}

async function speakUntilAgentResponds(): Promise<void> {
  act(() => {
    handlers().onFinal?.("tell me something", 120);
  });
  act(() => {
    handlers().onAgentThinking?.();
  });
  act(() => {
    handlers().onAgentResponse?.({ type: "agent_response", reply: makeReply() });
  });
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  cleanup();
  ctl.handlers = null;
  ctl.sent.length = 0;
  ctl.proxyStatus = "connected";
  ctl.lastError = null;
  ctl.sessionId = null;
  ctl.onRms = null;
  ctl.setCaptureStatus = null;
  ctl.connect.mockReset();
  ctl.disconnect.mockReset();
});

describe("App agent state flow", () => {
  it("idle → listening on mic press", async () => {
    render(<App />);
    expect(status()).toBe("Idle");

    await pressMic();

    expect(status()).toBe("Listening");
    expect(screen.getByRole("button", { name: "Stop microphone" })).toBeTruthy();
  });

  it("listening → processing on silence detected", async () => {
    render(<App />);
    await pressMic();
    expect(status()).toBe("Listening");

    act(() => {
      handlers().onFinal?.("what time is it", 148);
    });

    expect(status()).toBe("Processing");
  });

  it("processing → speaking on first TTS token", async () => {
    render(<App />);
    await pressMic();
    await speakUntilAgentResponds();
    expect(status()).toBe("Processing");

    act(() => {
      handlers().onTtsChunk?.(new ArrayBuffer(8), 1);
    });

    expect(status()).toBe("Speaking");
  });

  it("speaking → listening on barge-in (VAD-triggered abort)", async () => {
    render(<App />);
    await pressMic();
    await speakUntilAgentResponds();

    act(() => {
      handlers().onTtsChunk?.(new ArrayBuffer(8), 1);
    });
    expect(status()).toBe("Speaking");

    act(() => ctl.onRms?.(0.4));
    await new Promise((resolve) => setTimeout(resolve, 130));
    act(() => ctl.onRms?.(0.4));

    await waitFor(() => expect(status()).toBe("Listening"));
    expect(ctl.sent.some((msg) => msg.type === "barge_in")).toBe(true);
  });

  it("any → error on failed network call", async () => {
    render(<App />);
    await pressMic();
    expect(status()).toBe("Listening");

    act(() => {
      handlers().onError?.("ws_failed", "connection refused");
    });

    expect(status()).toBe("Error");
  });

  it("error → idle on retry", async () => {
    render(<App />);
    act(() => {
      handlers().onError?.("ws_failed", "connection refused");
    });
    expect(status()).toBe("Error");

    act(() => {
      handlers().onSessionId?.("sess-retry-1");
    });

    expect(status()).toBe("Idle");
  });
});
