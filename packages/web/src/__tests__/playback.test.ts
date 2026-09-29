import { describe, expect, it } from "vitest";
import { computePlaybackProgress } from "../lib/playback.js";

describe("computePlaybackProgress", () => {
  it("returns 0 before the first scheduled sample plays", () => {
    expect(computePlaybackProgress(10, 20, 9)).toBe(0);
    expect(computePlaybackProgress(10, 20, 10)).toBe(0);
  });

  it("returns a fraction of the scheduled window while playing", () => {
    expect(computePlaybackProgress(10, 20, 12.5)).toBeCloseTo(0.25, 5);
    expect(computePlaybackProgress(10, 20, 15)).toBeCloseTo(0.5, 5);
    expect(computePlaybackProgress(10, 20, 19)).toBeCloseTo(0.9, 5);
  });

  it("clamps to 1 once the scheduled window has elapsed", () => {
    expect(computePlaybackProgress(10, 20, 20)).toBe(1);
    expect(computePlaybackProgress(10, 20, 99)).toBe(1);
  });

  it("returns 0 when nothing has been scheduled yet", () => {
    expect(computePlaybackProgress(null, null, 5)).toBe(0);
    expect(computePlaybackProgress(10, null, 15)).toBe(0);
    expect(computePlaybackProgress(null, 20, 15)).toBe(0);
  });

  it("returns 0 for a zero or inverted window instead of dividing by zero", () => {
    expect(computePlaybackProgress(10, 10, 15)).toBe(0);
    expect(computePlaybackProgress(20, 10, 15)).toBe(0);
  });
});
