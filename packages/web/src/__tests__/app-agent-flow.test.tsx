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

// C9 — a turn that ends without audio (TTS failed or off) shows TOTAL as "—",
// not "pending": there will be no first audio byte to time.
describe("HUD TOTAL when a turn ends without audio", () => {
  const hud = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('section[role="status"][aria-label^="Latency"]');
    if (!el) throw new Error("latency HUD not found");
    return el;
  };
  const totalTile = (): string => {
    const tiles = hud().querySelectorAll(":scope > div");
    return tiles[tiles.length - 1]?.textContent ?? "";
  };

  it("while waiting for audio, TOTAL is pending", async () => {
    render(<App />);
    await pressMic();
    await speakUntilAgentResponds();
    expect(hud().getAttribute("aria-label")).toMatch(/Total pending/);
  });

  it("tts_done without any audio → TOTAL shows —, not pending", async () => {
    render(<App />);
    await pressMic();
    await speakUntilAgentResponds();
    act(() => {
      handlers().onTtsDone?.();
    });
    expect(hud().getAttribute("aria-label")).not.toMatch(/pending/);
    expect(hud().getAttribute("aria-label")).toMatch(/Total —, no audio/);
    expect(totalTile()).toBe("Total—");
    expect(hud().textContent).toMatch(/No audio/);
    expect(hud().textContent).not.toMatch(/Waiting for a request/);
  });

  it("a TTS error before any audio → TOTAL shows —, not pending", async () => {
    render(<App />);
    await pressMic();
    await speakUntilAgentResponds();
    act(() => {
      handlers().onError?.("tts_stream_error", "TTS failed");
    });
    expect(hud().getAttribute("aria-label")).not.toMatch(/pending/);
    expect(hud().getAttribute("aria-label")).toMatch(/Total —, no audio/);
    expect(totalTile()).toBe("Total—");
  });

  it("with audio, TOTAL is a number and the next turn starts pending again", async () => {
    render(<App />);
    await pressMic();
    await speakUntilAgentResponds();
    act(() => {
      handlers().onTtsDone?.();
    });
    await speakUntilAgentResponds();
    expect(hud().getAttribute("aria-label")).toMatch(/Total pending/);
    act(() => {
      handlers().onTtsChunk?.(new ArrayBuffer(8), 0);
    });
    expect(hud().getAttribute("aria-label")).toMatch(/Total \d+ milliseconds/);
    expect(hud().getAttribute("aria-label")).not.toMatch(/no audio/);
  });
});
