import type { AgentState } from "./agent-state.js";

const STATE_MESSAGES: Record<AgentState, string> = {
  idle: "Agent idle",
  listening: "Listening",
  processing: "Processing",
  speaking: "Agent speaking",
  error: "Something went wrong",
  disconnected: "Disconnected",
};

export function composeLiveMessage(state: AgentState, micOn: boolean): string {
  return `${STATE_MESSAGES[state]} · microphone ${micOn ? "on" : "off"}`;
}
