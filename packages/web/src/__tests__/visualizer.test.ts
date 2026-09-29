import { describe, expect, it } from "vitest";
import { VISUALIZER_CAPTIONS, visualizerCaption } from "../lib/visualizer.js";
import { computeBarHeights, STATIC_BAR_HEIGHT } from "../lib/waveform.js";
import type { AgentState } from "../state/agent-state.js";

const ALL_STATES: AgentState[] = [
  "idle",
  "listening",
  "processing",
  "speaking",
  "error",
  "disconnected",
];

describe("visualizerCaption", () => {
  it("names a distinct caption for every state, so the panel is never colour-only", () => {
    const captions = ALL_STATES.map((state) => visualizerCaption(state));

    expect(captions.every((caption) => caption.length > 0)).toBe(true);
    expect(new Set(captions).size).toBe(ALL_STATES.length);
  });

  it("describes what the panel is showing, not just the state name", () => {
    expect(visualizerCaption("listening")).toBe("Microphone level");
    expect(visualizerCaption("speaking")).toBe("Output level");
    expect(visualizerCaption("processing")).toBe("Waiting for the reply");
    expect(visualizerCaption("idle")).toBe("Mic off");
  });

  it("has a caption for every state", () => {
    for (const state of ALL_STATES) {
      expect(VISUALIZER_CAPTIONS[state]).toBeTruthy();
    }
  });
});

describe("computeBarHeights baseline", () => {
  it("draws a flat baseline when there are no samples, so the panel is never blank", () => {
    const heights = computeBarHeights([], 8, 56, false);

    expect(heights).toHaveLength(8);
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBe(STATIC_BAR_HEIGHT);
  });

  it("returns real amplitude bars once samples arrive", () => {
    const heights = computeBarHeights([0.4], 8, 56, false);

    expect(heights).toHaveLength(1);
    expect(heights[0]).toBeGreaterThan(STATIC_BAR_HEIGHT);
  });
});
