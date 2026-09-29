import type { AgentState } from "../state/agent-state.js";

export const VISUALIZER_CAPTIONS: Record<AgentState, string> = {
  idle: "Mic off",
  listening: "Microphone level",
  processing: "Waiting for the reply",
  speaking: "Output level",
  error: "No audio signal",
  disconnected: "Session closed",
};

export function visualizerCaption(state: AgentState): string {
  return VISUALIZER_CAPTIONS[state];
}
