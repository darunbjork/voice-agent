import type { ReactNode } from "react";
import { StatusRing, type AgentVisualState } from "./StatusRing.js";
import { WaveformCanvas } from "./WaveformCanvas.js";

export type VoiceAgentLayoutProps = {
  visualState: AgentVisualState;
  waveformBufferRef: React.RefObject<number[]>;
  waveformColor: string;
  statusLabel: string;
  children?: ReactNode;
};

export function VoiceAgentLayout({
  visualState,
  waveformBufferRef,
  waveformColor,
  statusLabel,
  children,
}: VoiceAgentLayoutProps) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 20,
        padding: "1.75rem",
        backdropFilter: "var(--blur)",
        boxShadow: "0 20px 50px rgba(0,0,0,0.4)",
        width: "100%",
        maxWidth: 440,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1.25rem",
          marginBottom: "1.25rem",
        }}
      >
        <StatusRing state={visualState} size={72} />
        <div>
          <div
            style={{
              fontSize: 12,
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 4,
            }}
          >
            Status
          </div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{statusLabel}</div>
        </div>
      </div>

      <div
        style={{
          background: "var(--surface-2)",
          borderRadius: 12,
          padding: "0.75rem 1rem",
          marginBottom: "1.25rem",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <WaveformCanvas
          bufferRef={waveformBufferRef}
          color={waveformColor}
          width={280}
          height={56}
          barCount={64}
        />
      </div>

      {children}
    </div>
  );
}
