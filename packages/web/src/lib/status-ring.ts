import type { AgentState } from "../state/agent-state.js";

export const STATE_RING_COLORS: Record<AgentState, string> = {
  idle: "#94a3b8",
  listening: "#22c55e",
  processing: "#f59e0b",
  speaking: "#a78bfa",
  error: "#ef4444",
  disconnected: "#64748b",
};

export type StaticRingSpec = {
  readonly strokeWidth: number;
  readonly dasharray: string | null;
  readonly glowOpacity: number;
};

export const STATIC_RING_SPECS: Record<AgentState, StaticRingSpec> = {
  idle: { strokeWidth: 3, dasharray: null, glowOpacity: 0.15 },
  listening: { strokeWidth: 5, dasharray: null, glowOpacity: 0.55 },
  processing: { strokeWidth: 3, dasharray: "60 200", glowOpacity: 0.15 },
  speaking: { strokeWidth: 4, dasharray: "10 10", glowOpacity: 0.5 },
  error: { strokeWidth: 6, dasharray: null, glowOpacity: 0.7 },
  disconnected: { strokeWidth: 3, dasharray: "2 8", glowOpacity: 0.1 },
};
