export type AgentState =
  "idle" | "listening" | "processing" | "speaking" | "error" | "disconnected";

export type AgentSnapshot = {
  readonly state: AgentState;
  readonly micOn: boolean;
};

export type AgentEvent =
  | { readonly type: "CONNECTED" }
  | { readonly type: "DISCONNECTED" }
  | { readonly type: "MIC_ON" }
  | { readonly type: "MIC_OFF" }
  | { readonly type: "TRANSCRIPT_FINAL" }
  | { readonly type: "AGENT_THINKING" }
  | { readonly type: "AGENT_RESPONSE" }
  | { readonly type: "TTS_START" }
  | { readonly type: "TTS_DONE" }
  | { readonly type: "BARGE_IN" }
  | { readonly type: "FAILED" };

export const initialAgentSnapshot: AgentSnapshot = {
  state: "idle",
  micOn: false,
};

function withState(snapshot: AgentSnapshot, state: AgentState): AgentSnapshot {
  return { state, micOn: snapshot.micOn };
}

export function agentReducer(snapshot: AgentSnapshot, event: AgentEvent): AgentSnapshot {
  switch (event.type) {
    case "CONNECTED":
      if (snapshot.state !== "disconnected") return snapshot;
      return withState(snapshot, snapshot.micOn ? "listening" : "idle");

    case "DISCONNECTED":
      return { state: "disconnected", micOn: false };

    case "MIC_ON":
      return { state: "listening", micOn: true };

    case "MIC_OFF":
      if (!snapshot.micOn) return snapshot;
      if (snapshot.state !== "listening") return { ...snapshot, micOn: false };
      return { state: "idle", micOn: false };

    case "TRANSCRIPT_FINAL":
    case "AGENT_THINKING":
    case "AGENT_RESPONSE":
      if (snapshot.state === "disconnected") return snapshot;
      return withState(snapshot, "processing");

    case "TTS_START":
      if (snapshot.state === "disconnected") return snapshot;
      return withState(snapshot, "speaking");

    case "TTS_DONE":
      if (snapshot.state !== "speaking" && snapshot.state !== "processing") return snapshot;
      return withState(snapshot, snapshot.micOn ? "listening" : "idle");

    case "BARGE_IN":
      if (snapshot.state === "disconnected") return snapshot;
      return withState(snapshot, snapshot.micOn ? "listening" : "idle");

    case "FAILED":
      return withState(snapshot, "error");

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
