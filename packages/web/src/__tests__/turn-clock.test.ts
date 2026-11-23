// HUD TOTAL = end of speech → first TTS audio byte, for that utterance only.
// The server says how long ago speech ended (sinceSpeechEndMs), so no clock
// comparison between server and browser is needed.
import { describe, it, expect } from "vitest";
import { createTurnClock } from "../state/turn-clock.js";

function fakeNow(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("turn clock", () => {
  it("TOTAL counts from the end of speech the server reported", () => {
    const clock = fakeNow();
    const turn = createTurnClock(clock.now);
    turn.finalReceived(600); // speech ended 600 ms before the final arrived
    clock.advance(900); // LLM + TTS until the first audio byte
    expect(turn.firstAudio()).toBe(1500);
  });

  it("a later turn is timed on its own, not from an earlier one", () => {
    const clock = fakeNow();
    const turn = createTurnClock(clock.now);
    turn.finalReceived(500);
    clock.advance(1000);
    expect(turn.firstAudio()).toBe(1500);

    clock.advance(60_000); // a minute of silence
    turn.finalReceived(300);
    clock.advance(700);
    expect(turn.firstAudio()).toBe(1000);
  });

  it("only the first audio byte of a turn counts", () => {
    const clock = fakeNow();
    const turn = createTurnClock(clock.now);
    turn.finalReceived(200);
    clock.advance(800);
    expect(turn.firstAudio()).toBe(1000);
    clock.advance(500);
    expect(turn.firstAudio()).toBeNull();
  });

  it("typed input (no speech-end time) is timed from when its final arrived", () => {
    const clock = fakeNow();
    const turn = createTurnClock(clock.now);
    turn.finalReceived(undefined);
    clock.advance(1200);
    expect(turn.firstAudio()).toBe(1200);
  });

  it("no final yet → no TOTAL", () => {
    expect(createTurnClock(fakeNow().now).firstAudio()).toBeNull();
  });
});
