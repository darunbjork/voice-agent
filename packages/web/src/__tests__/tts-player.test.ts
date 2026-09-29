import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTTSPlayer } from "../hooks/useTTSPlayer.js";

class MockSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startedAt = -1;
  stopped = false;
  connectedTo: unknown = null;

  connect(node: unknown): void {
    this.connectedTo = node;
  }

  disconnect(): void {
    this.connectedTo = null;
  }

  start(when = 0): void {
    this.startedAt = when;
  }

  stop(): void {
    this.stopped = true;
  }
}

class MockAnalyser {
  fftSize = 1024;
  fill = 0;
  connectedTo: unknown = null;

  connect(node: unknown): void {
    this.connectedTo = node;
  }

  disconnect(): void {
    this.connectedTo = null;
  }

  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(this.fill);
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];

  currentTime = 0;
  state = "running";
  destination = { kind: "destination" };
  sources: MockSource[] = [];
  analyser: MockAnalyser | null = null;

  constructor(_options?: unknown) {
    MockAudioContext.instances.push(this);
  }

  createBuffer(
    _channels: number,
    length: number,
    sampleRate: number,
  ): {
    duration: number;
    copyToChannel: (source: Float32Array, channel: number) => void;
  } {
    return {
      duration: length / sampleRate,
      copyToChannel: () => undefined,
    };
  }

  createBufferSource(): MockSource {
    const source = new MockSource();
    this.sources.push(source);
    return source;
  }

  createAnalyser(): MockAnalyser {
    this.analyser = new MockAnalyser();
    return this.analyser;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}

function pcm(seconds: number): ArrayBuffer {
  return new Int16Array(Math.round(16_000 * seconds)).buffer;
}

function lastContext(): MockAudioContext {
  const ctx = MockAudioContext.instances.at(-1);
  if (!ctx) throw new Error("no AudioContext was created");
  return ctx;
}

beforeEach(() => {
  MockAudioContext.instances = [];
  vi.stubGlobal("AudioContext", MockAudioContext);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useTTSPlayer playback progress", () => {
  it("reports playing and walks the scheduled window as the clock advances", async () => {
    const { result, unmount } = renderHook(() => useTTSPlayer());

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
    });

    expect(result.current.status).toBe("playing");
    expect(result.current.isPlaying).toBe(true);

    const ctx = lastContext();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.analyser).not.toBeNull();

    expect(result.current.getProgress()).toBe(0);

    ctx.currentTime = 0.1;
    expect(result.current.getProgress()).toBeCloseTo(0.5, 5);

    ctx.currentTime = 0.2;
    expect(result.current.getProgress()).toBe(1);

    unmount();
  });

  it("extends the scheduled window as more chunks are enqueued", async () => {
    const { result, unmount } = renderHook(() => useTTSPlayer());

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
      await result.current.enqueue(pcm(0.2), 1);
    });

    const ctx = lastContext();
    ctx.currentTime = 0.3;
    expect(result.current.getProgress()).toBeCloseTo(0.75, 5);

    unmount();
  });

  it("starts a new window after prepare resets the clock", async () => {
    const { result, unmount } = renderHook(() => useTTSPlayer());

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
    });

    const ctx = lastContext();
    ctx.currentTime = 1;
    expect(result.current.getProgress()).toBe(1);

    act(() => {
      result.current.prepare();
    });
    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
    });

    expect(result.current.status).toBe("playing");

    ctx.currentTime = 1.1;
    expect(result.current.getProgress()).toBeCloseTo(0.5, 5);

    unmount();
  });

  it("reports no progress before any audio context exists", () => {
    const { result, unmount } = renderHook(() => useTTSPlayer());
    expect(result.current.getProgress()).toBe(0);
    unmount();
  });
});

describe("useTTSPlayer completion", () => {
  it("finishes only after every scheduled source has ended", async () => {
    const onDone = vi.fn();
    const { result, unmount } = renderHook(() => useTTSPlayer({ onDone }));

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
    });

    act(() => {
      result.current.markDone();
    });
    expect(onDone).not.toHaveBeenCalled();
    expect(result.current.status).toBe("playing");

    await act(async () => {
      lastContext().sources[0]?.onended?.();
    });

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("idle");
    expect(result.current.getProgress()).toBe(0);

    unmount();
  });

  it("marks a cancelled turn as cancelled and ignores late chunks", async () => {
    const onCancel = vi.fn();
    const { result, unmount } = renderHook(() => useTTSPlayer({ onCancel }));

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
    });

    act(() => {
      result.current.cancel();
    });

    expect(result.current.status).toBe("cancelled");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(lastContext().sources[0]?.stopped).toBe(true);
    expect(result.current.getProgress()).toBe(0);

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 1);
    });

    expect(result.current.status).toBe("cancelled");
    expect(lastContext().sources).toHaveLength(1);

    unmount();
  });

  it("turns a construction failure into an error state", async () => {
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("audio device unavailable");
        }
      },
    );

    const { result, unmount } = renderHook(() => useTTSPlayer());

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("audio device unavailable");

    unmount();
  });
});

describe("useTTSPlayer output level", () => {
  it("feeds RMS from the analyser while audio is scheduled", async () => {
    const levels: number[] = [];
    const { result, unmount } = renderHook(() =>
      useTTSPlayer({ onLevel: (rms) => levels.push(rms) }),
    );

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
    });

    lastContext().analyser!.fill = 0.5;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0]).toBeCloseTo(0.5, 5);

    act(() => {
      result.current.cancel();
    });

    const seen = levels.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(levels.length).toBe(seen);

    unmount();
  });

  it("stops feeding after unmount", async () => {
    const levels: number[] = [];
    const { result, unmount } = renderHook(() =>
      useTTSPlayer({ onLevel: (rms) => levels.push(rms) }),
    );

    await act(async () => {
      await result.current.enqueue(pcm(0.2), 0);
    });
    lastContext().analyser!.fill = 0.4;

    unmount();

    const seen = levels.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(levels.length).toBe(seen);
    expect(lastContext().state).toBe("closed");
  });
});
