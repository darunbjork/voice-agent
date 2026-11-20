import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTTSPlayer } from "../hooks/useTTSPlayer.js";
import { Pcm16Aligner } from "../lib/pcm-align.js";

/** Captures the decoded float samples of every scheduled buffer. */
class CapturingContext {
  static last: CapturingContext | null = null;
  currentTime = 0;
  state = "running";
  destination = {};
  decoded: number[] = [];
  constructor() {
    CapturingContext.last = this;
  }
  createBuffer(_c: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      copyToChannel: (src: Float32Array) => {
        this.decoded.push(...Array.from(src, (f) => Math.round(f * 32768)));
      },
    };
  }
  createBufferSource() {
    return { buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} };
  }
  createAnalyser() {
    return { fftSize: 1024, connect() {}, disconnect() {}, getFloatTimeDomainData() {} };
  }
  async resume() {}
  async close() {
    this.state = "closed";
  }
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", CapturingContext);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SAMPLES = [1000, -1000, 12345, -32768, 32767, 7, -7, 2000];

function le16(values: number[]): Uint8Array<ArrayBuffer> {
  const view = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return new Uint8Array(view.buffer);
}

function slices(bytes: Uint8Array, sizes: number[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  let o = 0;
  for (const s of sizes) {
    out.push(bytes.slice(o, o + s).buffer);
    o += s;
  }
  return out;
}

describe("Pcm16Aligner (web)", () => {
  it("re-joins a sample split across chunks", () => {
    const a = new Pcm16Aligner();
    expect(a.push(new Uint8Array([0x34]))).toBeNull();
    expect(new Uint8Array(a.push(new Uint8Array([0x12, 0x78]))!)).toEqual(
      new Uint8Array([0x34, 0x12]),
    );
  });
});

describe("useTTSPlayer with odd-length PCM chunks", () => {
  it("decodes the original samples instead of erroring or byte-shifting", async () => {
    const { result } = renderHook(() => useTTSPlayer());
    const bytes = le16(SAMPLES);

    await act(async () => {
      for (const [i, chunk] of slices(bytes, [3, 4, 1, 5, 3]).entries()) {
        await result.current.enqueue(chunk, i);
      }
    });

    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe("playing");
    expect(CapturingContext.last!.decoded).toEqual(SAMPLES);
  });

  it("does not carry a half sample from a cancelled reply into the next one", async () => {
    const { result } = renderHook(() => useTTSPlayer());

    await act(async () => {
      await result.current.enqueue(new Uint8Array([0xff, 0xff, 0xff]).buffer, 0);
      result.current.cancel();
      result.current.prepare();
      await result.current.enqueue(le16([1000]).buffer, 0);
    });

    expect(CapturingContext.last!.decoded.at(-1)).toBe(1000);
  });
});
