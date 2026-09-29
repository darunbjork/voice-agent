import { describe, expect, it } from "vitest";
import {
  countWords,
  initialRevealState,
  revealReducer,
  revealTokens,
  type RevealSnapshot,
} from "../state/response-reveal.js";

function start(text: string, reduced = false): RevealSnapshot {
  return revealReducer(initialRevealState, { type: "START", text, reduced });
}

describe("revealReducer", () => {
  it("starts at zero words and reveals them as playback progresses", () => {
    const started = start("Here is the answer.");
    expect(started).toEqual({ status: "revealing", totalWords: 4, revealedWords: 0 });

    const half = revealReducer(started, { type: "PROGRESS", progress: 0.5 });
    expect(half.status).toBe("revealing");
    expect(half.revealedWords).toBe(2);
  });

  it("reveals every word once playback reaches the end", () => {
    const snapshot = revealReducer(start("One two three four"), {
      type: "PROGRESS",
      progress: 1,
    });
    expect(snapshot).toEqual({ status: "complete", totalWords: 4, revealedWords: 4 });
  });

  it("never walks the reveal backwards and ignores non-finite progress", () => {
    const advanced = revealReducer(start("alpha beta gamma"), {
      type: "PROGRESS",
      progress: 0.4,
    });
    expect(advanced.revealedWords).toBe(2);

    const same = revealReducer(advanced, { type: "PROGRESS", progress: 0.1 });
    expect(same).toBe(advanced);

    const invalid = revealReducer(advanced, { type: "PROGRESS", progress: Number.NaN });
    expect(invalid).toBe(advanced);

    const overshoot = revealReducer(advanced, { type: "PROGRESS", progress: 99 });
    expect(overshoot).toEqual({ status: "complete", totalWords: 3, revealedWords: 3 });
  });

  it("jumps straight to complete under reduced motion", () => {
    expect(start("A reply for the user", true)).toEqual({
      status: "complete",
      totalWords: 5,
      revealedWords: 5,
    });
  });

  it("completes immediately when there is nothing to reveal", () => {
    expect(start("   ")).toEqual({ status: "complete", totalWords: 0, revealedWords: 0 });
  });

  it("completes on demand, which is how barge-in frees the remaining text", () => {
    const started = start("Interrupted reply");
    const done = revealReducer(started, { type: "COMPLETE" });
    expect(done).toEqual({ status: "complete", totalWords: 2, revealedWords: 2 });
  });

  it("ignores progress and completion while idle", () => {
    const progress = revealReducer(initialRevealState, { type: "PROGRESS", progress: 1 });
    expect(progress).toBe(initialRevealState);

    const complete = revealReducer(initialRevealState, { type: "COMPLETE" });
    expect(complete).toBe(initialRevealState);
  });

  it("resets back to idle", () => {
    const started = start("Some reply");
    expect(revealReducer(started, { type: "RESET" })).toBe(initialRevealState);
  });
});

describe("countWords", () => {
  it("counts whitespace-separated words and treats blank text as zero", () => {
    expect(countWords("one  two\tthree")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countWords(" leading")).toBe(1);
  });
});

describe("revealTokens", () => {
  it("keeps whitespace separate so the text never reflows", () => {
    const tokens = revealTokens("Here  is\nit.");
    expect(tokens.map((token) => token.text)).toEqual(["Here", "  ", "is", "\n", "it."]);
    expect(tokens.map((token) => token.wordIndex)).toEqual([0, null, 1, null, 2]);
  });

  it("splits the words so unrevealed ones can be hidden one at a time", () => {
    const tokens = revealTokens("alpha beta");
    const visible = tokens.filter((token) => token.wordIndex !== null && token.wordIndex < 1);
    expect(visible.map((token) => token.text)).toEqual(["alpha"]);
  });
});
