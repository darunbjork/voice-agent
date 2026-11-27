// C10 — cold start. Fly scales the API and Postgres to zero; the first request
// after idle took 25.7 s (/health), warm 0.16 s, and visitors thought the app
// was broken. On page load the app sends one GET /health (no-store) to wake
// the API and the DB, shows "Waking up the server… Ns" with a live counter,
// then "Ready". After 60 s without an answer it shows a Retry button. Input
// while waking is kept and sent once the server is ready.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientAudioMessage } from "@voice-agent/shared-types";
import { App } from "../App.js";
import type { CaptureStatus } from "../hooks/useAudioCapture.js";

const ctl = vi.hoisted(() => ({
  sent: [] as ClientAudioMessage[],
  connect: vi.fn(),
  captureStart: vi.fn(),
}));

vi.mock("../lib/feedback-tone.js", () => ({ playFeedbackTone: vi.fn() }));

vi.mock("../hooks/useDeepgramProxy.js", () => ({
  useDeepgramProxy: () => ({
    status: "idle",
    sessionId: null,
    lastError: null,
    connect: ctl.connect,
    disconnect: () => undefined,
    sendAudio: () => undefined,
    sendMessage: (msg: ClientAudioMessage) => {
      ctl.sent.push(msg);
    },
    isConnected: false,
  }),
}));

vi.mock("../hooks/useAudioCapture.js", async () => {
  const { useState } = await import("react");
  return {
    useAudioCapture: () => {
      const [status, setStatus] = useState<CaptureStatus>("idle");
      return {
        status,
        error: null,
        isCapturing: status === "capturing",
        start: async () => {
          ctl.captureStart();
          setStatus("capturing");
        },
        stop: () => setStatus("idle"),
      };
    },
  };
});

vi.mock("../hooks/useTTSPlayer.js", () => ({
  useTTSPlayer: () => ({
    status: "idle",
    error: null,
    isPlaying: false,
    enqueue: async () => undefined,
    markDone: () => undefined,
    cancel: () => undefined,
    prepare: () => undefined,
  }),
}));

/** A /health request the test answers (or never answers) by hand. */
type Pending = {
  url: string;
  init?: RequestInit;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
};
let requests: Pending[] = [];
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  return new Promise<Response>((resolve, reject) => {
    requests.push({ url, init, resolve, reject });
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });
});

const healthy = () =>
  new Response(JSON.stringify({ status: "ok", db: "ok", redis: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const chip = () => screen.getByTestId("server-status").textContent ?? "";

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function answer(index: number, response: Response): Promise<void> {
  await act(async () => {
    requests[index]?.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
  requests = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  ctl.sent.length = 0;
  ctl.connect.mockReset();
  ctl.captureStart.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cold start: waking → ready", () => {
  it("sends one no-store GET /health on load, counts seconds, then shows Ready", async () => {
    render(<App />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0]?.url).toMatch(/\/health$/);
    expect(requests[0]?.init?.cache).toBe("no-store");
    expect(chip()).toMatch(/Waking up the server… 0s/);
    expect(chip()).toMatch(/free hosting, can take ~30 s/);

    await advance(3_000);
    expect(chip()).toMatch(/Waking up the server… 3s/);

    await advance(22_000); // a cold start: the one request is still open at 25 s
    expect(chip()).toMatch(/25s/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await answer(0, healthy());
    expect(chip()).toMatch(/^Ready/);
    expect(chip()).not.toMatch(/Waking/);
  });

  it("does not poll once ready, and touches no LLM/TTS/STT (no socket, no messages)", async () => {
    render(<App />);
    await answer(0, healthy());
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctl.connect).not.toHaveBeenCalled();
    expect(ctl.sent).toEqual([]);
  });

  it("a DB still waking (status down) is not ready: it retries with backoff", async () => {
    render(<App />);
    await answer(0, new Response(JSON.stringify({ status: "down", db: "down" }), { status: 200 }));
    expect(chip()).toMatch(/Waking/);
    await advance(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // retry after 1 s
    await answer(1, healthy());
    expect(chip()).toMatch(/^Ready/);
  });
});

describe("cold start: waking → 60 s → retry", () => {
  it("failed requests retry with backoff (not every second) and give up at 60 s", async () => {
    render(<App />);
    // Each request fails at once (Fly answers 503 while the machine starts).
    const failAll = async () => {
      await act(async () => {
        for (const r of requests) r.resolve(new Response("", { status: 503 }));
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    for (let s = 0; s < 60; s++) {
      await failAll();
      await advance(1_000);
    }
    await failAll();

    // 1, 2, 4, 8, 8, … s apart: at most 11 requests in 60 s, far fewer than 60.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(11);
    expect(chip()).toMatch(/Server didn't wake up/);
    const retry = within(screen.getByTestId("server-status")).getByRole("button", {
      name: /retry/i,
    });

    // No more requests after giving up, until the visitor asks.
    const calls = fetchMock.mock.calls.length;
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(calls);

    act(() => {
      fireEvent.click(retry);
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    expect(chip()).toMatch(/Waking up the server… 0s/);
    await answer(calls, healthy());
    expect(chip()).toMatch(/^Ready/);
  });

  it("a request that hangs for 60 s is aborted and shows Retry", async () => {
    render(<App />);
    await advance(59_000);
    expect(chip()).toMatch(/59s/);
    await advance(1_000);
    expect(requests[0]?.init?.signal?.aborted).toBe(true);
    expect(chip()).toMatch(/Server didn't wake up/);
    expect(
      within(screen.getByTestId("server-status")).getByRole("button", { name: /retry/i }),
    ).toBeTruthy();
  });
});

describe("input while waking waits, then sends", () => {
  it("typed text shows 'Waiting for the server' and is sent once ready", async () => {
    render(<App />);
    const input = screen.getByLabelText("Message");
    act(() => {
      fireEvent.change(input, { target: { value: "What's the weather in Stockholm?" } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });

    expect(ctl.sent).toEqual([]);
    expect(ctl.connect).not.toHaveBeenCalled();
    expect(screen.getByText(/Waiting for the server/)).toBeTruthy();

    await advance(10_000);
    expect(ctl.sent).toEqual([]);

    await answer(0, healthy());
    expect(ctl.sent).toEqual([{ type: "text_input", text: "What's the weather in Stockholm?" }]);
    expect(ctl.connect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Waiting for the server/)).toBeNull();
  });

  it("the mic pressed while waking starts once ready", async () => {
    render(<App />);
    const mic = screen.getByRole("button", { name: "Start microphone" });
    await act(async () => {
      fireEvent.keyDown(mic, { key: "Enter" });
    });
    expect(ctl.captureStart).not.toHaveBeenCalled();
    expect(ctl.connect).not.toHaveBeenCalled();
    expect(screen.getByText(/Waiting for the server/)).toBeTruthy();

    await answer(0, healthy());
    expect(ctl.connect).toHaveBeenCalledTimes(1);
    expect(ctl.captureStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Waiting for the server/)).toBeNull();
  });

  it("input after ready is sent at once", async () => {
    render(<App />);
    await answer(0, healthy());
    const input = screen.getByLabelText("Message");
    act(() => {
      fireEvent.change(input, { target: { value: "hello" } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    expect(ctl.sent).toEqual([{ type: "text_input", text: "hello" }]);
    expect(screen.queryByText(/Waiting for the server/)).toBeNull();
  });
});

// C10b: the header chip is above the fold and easy to miss; the waking state
// is also shown right by the mic and the text input.
describe("waking state next to the mic and the input", () => {
  const inline = () => screen.queryByTestId("server-status-inline");

  it("shows the live waking status between the mic and the input", async () => {
    render(<App />);
    await advance(3_000);
    const status = screen.getByTestId("server-status-inline");
    expect(status.textContent).toMatch(/Waking up the server… 3s/);
    const mic = screen.getByRole("button", { name: "Start microphone" });
    const input = screen.getByLabelText("Message");
    // DOM order: mic → status → input.
    expect(mic.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input.getAttribute("placeholder")).toMatch(/sent when ready/i);
  });

  it("goes away once ready; the input placeholder is back to normal", async () => {
    render(<App />);
    await answer(0, healthy());
    expect(inline()).toBeNull();
    expect(screen.getByLabelText("Message").getAttribute("placeholder")).toBe("Type a message…");
  });

  it("after 60 s it offers Retry next to the input too", async () => {
    render(<App />);
    await advance(60_000);
    const status = inline();
    expect(status?.textContent).toMatch(/Server didn't wake up/);
    const retry = within(status as HTMLElement).getByRole("button", { name: /retry/i });
    const calls = fetchMock.mock.calls.length;
    act(() => {
      fireEvent.click(retry);
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    expect(inline()?.textContent).toMatch(/Waking up the server… 0s/);
  });
});
