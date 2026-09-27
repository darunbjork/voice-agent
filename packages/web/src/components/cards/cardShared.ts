import type { CSSProperties } from "react";
import type { ResponseCard } from "@voice-agent/shared-types";

export const CARD_ACCENT: Record<ResponseCard["type"], string> = {
  weather: "#38bdf8",
  reminder: "#f59e0b",
  translate: "#a78bfa",
  summary: "#22c55e",
  help: "#94a3b8",
};

export const cardShell = (accent: string): CSSProperties => ({
  marginTop: 8,
  borderRadius: "var(--radius-md)",
  border: `1px solid ${accent}40`,
  background: "var(--surface)",
  overflow: "hidden",
});

export const cardTitleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 8,
};

export const cardTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--muted)",
};

export const cardBodyPad: CSSProperties = {
  padding: "0.85rem 1rem",
};
