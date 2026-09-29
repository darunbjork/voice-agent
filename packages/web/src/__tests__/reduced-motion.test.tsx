import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, useReducedMotion, REDUCED_MOTION_QUERY } from "../lib/motion.js";
import { STATIC_RING_SPECS, STATE_RING_COLORS } from "../lib/status-ring.js";
import { computeBarHeights, MIN_BAR_HEIGHT, STATIC_BAR_HEIGHT } from "../lib/waveform.js";
import { ChatLog } from "../components/VoiceAgent/ChatLog.js";
import type { AgentState } from "../state/agent-state.js";
import type { ChatMessageModel } from "../types/chat.js";

const ALL_STATES: AgentState[] = [
  "idle",
  "listening",
  "processing",
  "speaking",
  "error",
  "disconnected",
];

type MatchMediaControl = {
  matches: boolean;
  listeners: Array<() => void>;
  emit: () => void;
};

const originalMatchMedia = window.matchMedia;
let control: MatchMediaControl | null = null;

function installMatchMedia(initial: boolean): MatchMediaControl {
  control = { matches: initial, listeners: [], emit: () => undefined };
  const c = control;
  c.emit = () => {
    for (const listener of c.listeners) listener();
  };
  window.matchMedia = ((query: string) => ({
    get matches() {
      return c.matches;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => {
      c.listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      c.listeners = c.listeners.filter((l) => l !== listener);
    },
  })) as unknown as typeof window.matchMedia;
  return c;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  control = null;
  window.matchMedia = originalMatchMedia;
});

describe("prefersReducedMotion", () => {
  it("returns false when matchMedia is unavailable", () => {
    const win = window as unknown as { matchMedia?: unknown };
    delete win.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("returns true when the reduce query matches", () => {
    installMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(window.matchMedia(REDUCED_MOTION_QUERY).matches).toBe(true);
  });

  it("returns false when the reduce query does not match", () => {
    installMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("useReducedMotion", () => {
  it("tracks the live media-query value, including changes", () => {
    const c = installMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      c.matches = true;
      c.emit();
    });

    expect(result.current).toBe(true);
  });
});

describe("static ring specs (reduced-motion status ring)", () => {
  it("gives every state a distinct shape, not just a distinct colour", () => {
    const shapes = ALL_STATES.map((state) => {
      const spec = STATIC_RING_SPECS[state];
      return `${spec.strokeWidth}|${spec.dasharray ?? "solid"}`;
    });

    expect(new Set(shapes).size).toBe(ALL_STATES.length);
  });

  it("keeps spec values inside the drawing bounds", () => {
    for (const state of ALL_STATES) {
      const spec = STATIC_RING_SPECS[state];
      expect(spec.strokeWidth).toBeGreaterThan(0);
      expect(spec.glowOpacity).toBeGreaterThan(0);
      expect(spec.glowOpacity).toBeLessThanOrEqual(1);
    }
  });

  it("has a colour for every state so animated and static rings match", () => {
    for (const state of ALL_STATES) {
      expect(STATE_RING_COLORS[state]).toMatch(/^#/);
    }
  });
});

describe("computeBarHeights", () => {
  it("renders a static uniform frame under reduced motion, ignoring live samples", () => {
    const heights = computeBarHeights([0.9, 0.1, 0.5], 8, 56, true);

    expect(heights).toHaveLength(8);
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBe(STATIC_BAR_HEIGHT);
  });

  it("never exceeds the canvas height under reduced motion", () => {
    const heights = computeBarHeights([], 4, 3, true);
    expect(heights.every((h) => h <= 3)).toBe(true);
    expect(heights.every((h) => h > 0)).toBe(true);
  });

  it("maps amplitudes to clamped bar heights during normal motion", () => {
    const heights = computeBarHeights([0, 1, 0.5], 3, 56, false);

    expect(heights[0]).toBe(MIN_BAR_HEIGHT);
    expect(heights[1]).toBe(56);
    expect(heights[2]).toBe(Math.min(56, 0.5 * 56 * 1.8));
  });

  it("never draws more bars than the canvas holds", () => {
    const heights = computeBarHeights([1, 1, 1, 1], 2, 56, false);
    expect(heights).toHaveLength(2);
  });
});

describe("ChatLog scroll behavior under reduced motion", () => {
  const message: ChatMessageModel = {
    id: "m1",
    role: "agent",
    text: "Hello there.",
    card: null,
    createdAt: "2026-09-29T10:00:00.000Z",
  };
  const scrollSpy = vi.fn();

  beforeEach(() => {
    scrollSpy.mockReset();
    Element.prototype.scrollIntoView =
      scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
  });

  it("scrolls instantly when the user prefers reduced motion", () => {
    installMatchMedia(true);
    render(<ChatLog messages={[message]} />);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "auto" });
  });

  it("scrolls smoothly otherwise", () => {
    installMatchMedia(false);
    render(<ChatLog messages={[message]} />);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth" });
  });
});
