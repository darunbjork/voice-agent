import { describe, expect, it } from "vitest";
import { agentReducer, initialAgentSnapshot } from "../state/agent-state.js";
import type { AgentEvent, AgentSnapshot, AgentState } from "../state/agent-state.js";

function reduce(events: AgentEvent[], start?: AgentSnapshot): AgentSnapshot {
  return events.reduce(agentReducer, start ?? initialAgentSnapshot);
}

const ALL_STATES: AgentState[] = [
  "idle",
  "listening",
  "processing",
  "speaking",
  "error",
  "disconnected",
];

describe("agentReducer", () => {
  it("idle → listening on mic press", () => {
    const next = reduce([{ type: "MIC_ON" }]);

    expect(next.state).toBe("listening");
    expect(next.micOn).toBe(true);
  });

  it("listening → processing on silence detected", () => {
    const next = reduce([{ type: "MIC_ON" }, { type: "TRANSCRIPT_FINAL" }]);

    expect(next.state).toBe("processing");
    expect(next.micOn).toBe(true);
  });

  it("processing → speaking on first TTS token", () => {
    const next = reduce([{ type: "MIC_ON" }, { type: "TRANSCRIPT_FINAL" }, { type: "TTS_START" }]);

    expect(next.state).toBe("speaking");
    expect(next.micOn).toBe(true);
  });

  it("speaking → listening on barge-in (VAD-triggered abort)", () => {
    const next = reduce([
      { type: "MIC_ON" },
      { type: "TRANSCRIPT_FINAL" },
      { type: "TTS_START" },
      { type: "BARGE_IN" },
    ]);

    expect(next.state).toBe("listening");
    expect(next.micOn).toBe(true);
  });

  it("any → error on failed network call", () => {
    for (const state of ALL_STATES) {
      const next = agentReducer({ state, micOn: state !== "idle" }, { type: "FAILED" });

      expect(next.state).toBe("error");
    }
  });

  it("error → idle on retry", () => {
    const next = agentReducer({ state: "error", micOn: false }, { type: "CONNECTED" });

    expect(next.state).toBe("idle");
    expect(next.micOn).toBe(false);
  });

  it("error → listening on retry with the mic still on", () => {
    const next = agentReducer({ state: "error", micOn: true }, { type: "CONNECTED" });

    expect(next.state).toBe("listening");
    expect(next.micOn).toBe(true);
  });

  it("disconnected ignores mic and turn events until it reconnects", () => {
    const start: AgentSnapshot = { state: "disconnected", micOn: false };

    expect(agentReducer(start, { type: "TRANSCRIPT_FINAL" }).state).toBe("disconnected");
    expect(agentReducer(start, { type: "TTS_START" }).state).toBe("disconnected");
    expect(agentReducer(start, { type: "BARGE_IN" }).state).toBe("disconnected");
    expect(agentReducer(start, { type: "MIC_ON" }).state).toBe("listening");
  });
});
