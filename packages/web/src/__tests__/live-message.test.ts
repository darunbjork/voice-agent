import { describe, expect, it } from "vitest";
import { composeLiveMessage } from "../state/live-message.js";
import { agentReducer, initialAgentSnapshot } from "../state/agent-state.js";
import type { AgentEvent, AgentSnapshot, AgentState } from "../state/agent-state.js";

const ALL_STATES: AgentState[] = [
  "idle",
  "listening",
  "processing",
  "speaking",
  "error",
  "disconnected",
];

function reduce(events: AgentEvent[], start?: AgentSnapshot): AgentSnapshot {
  return events.reduce(agentReducer, start ?? initialAgentSnapshot);
}

describe("composeLiveMessage", () => {
  it("announces the state together with the microphone capture status", () => {
    expect(composeLiveMessage("speaking", true)).toBe("Agent speaking · microphone on");
    expect(composeLiveMessage("processing", true)).toBe("Processing · microphone on");
    expect(composeLiveMessage("idle", false)).toBe("Agent idle · microphone off");
  });

  it("always reports the microphone capture status, in every state", () => {
    for (const state of ALL_STATES) {
      expect(composeLiveMessage(state, false).endsWith("microphone off")).toBe(true);
      expect(composeLiveMessage(state, true).endsWith("microphone on")).toBe(true);
      expect(composeLiveMessage(state, false).length).toBeGreaterThan("microphone off".length);
    }
  });

  it("differs between mic-on and mic-off for the same state", () => {
    for (const state of ALL_STATES) {
      expect(composeLiveMessage(state, true)).not.toBe(composeLiveMessage(state, false));
    }
  });
});

describe("micOn semantics (capture status in the agent snapshot)", () => {
  it("keeps the mic hot through transcript, thinking, response and TTS", () => {
    const next = reduce([
      { type: "MIC_ON" },
      { type: "TRANSCRIPT_FINAL" },
      { type: "AGENT_THINKING" },
      { type: "AGENT_RESPONSE" },
      { type: "TTS_START" },
    ]);

    expect(next.state).toBe("speaking");
    expect(next.micOn).toBe(true);
  });

  it("keeps the mic hot after barge-in so the next turn can be heard", () => {
    const next = reduce([
      { type: "MIC_ON" },
      { type: "TRANSCRIPT_FINAL" },
      { type: "TTS_START" },
      { type: "BARGE_IN" },
    ]);

    expect(next.state).toBe("listening");
    expect(next.micOn).toBe(true);
  });

  it("turning the mic off mid-speech clears capture without changing the state", () => {
    const next = reduce([
      { type: "MIC_ON" },
      { type: "TRANSCRIPT_FINAL" },
      { type: "TTS_START" },
      { type: "MIC_OFF" },
    ]);

    expect(next.micOn).toBe(false);
    expect(next.state).toBe("speaking");
  });

  it("disconnect always clears the mic", () => {
    const next = reduce([{ type: "MIC_ON" }, { type: "DISCONNECTED" }]);

    expect(next.micOn).toBe(false);
    expect(next.state).toBe("disconnected");
  });

  it("a failed turn never silently turns the mic off", () => {
    const next = reduce([{ type: "MIC_ON" }, { type: "TRANSCRIPT_FINAL" }, { type: "FAILED" }]);

    expect(next.state).toBe("error");
    expect(next.micOn).toBe(true);
  });
});
