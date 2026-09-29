import type { ReactNode } from "react";
import { GlassCard } from "./GlassCard.js";
import { StatusRing } from "./StatusRing.js";
import type { AgentState } from "../../state/agent-state.js";
import { WaveformCanvas } from "./WaveformCanvas.js";

export type VoiceAgentLayoutProps = {
  visualState: AgentState;
  micOn: boolean;
  waveformBufferRef: React.RefObject<number[]>;
  waveformColor: string;
  statusLabel: string;
  statusActive?: boolean;
  sessionId: string | null;
  children?: ReactNode;
  footer?: ReactNode;
};

export function VoiceAgentLayout({
  visualState,
  micOn,
  waveformBufferRef,
  waveformColor,
  statusLabel,
  statusActive = false,
  sessionId,
  children,
  footer,
}: VoiceAgentLayoutProps) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 480,
        margin: "0 auto",
      }}
    >
      <GlassCard>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1.5rem",
            gap: "1rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <StatusRing state={visualState} size={64} />
            <div>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 2,
                }}
              >
                Status
              </div>
              <div
                className={statusActive ? "status-value is-active" : "status-value"}
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                }}
              >
                {statusLabel}
              </div>
              <span className={micOn ? "mic-chip mic-chip--on" : "mic-chip"}>
                <span className="mic-chip__dot" aria-hidden="true" />
                {micOn ? "Mic on" : "Mic off"}
                <span className="sr-only">
                  {micOn
                    ? " — microphone is capturing audio, you can interrupt"
                    : " — microphone is not capturing audio"}
                </span>
              </span>
            </div>
          </div>
          {sessionId && (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--muted)",
                background: "var(--surface-2)",
                padding: "0.35rem 0.6rem",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
              }}
              title={sessionId}
            >
              {sessionId.slice(0, 8)}
            </div>
          )}
        </div>

        <div
          style={{
            background: "var(--surface-2)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)",
            padding: "0.85rem 1rem",
            marginBottom: "1.25rem",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <WaveformCanvas
            bufferRef={waveformBufferRef}
            color={waveformColor}
            width={300}
            height={56}
            barCount={64}
          />
        </div>

        {children}
      </GlassCard>

      {footer && (
        <div
          style={{
            marginTop: "1rem",
            textAlign: "center",
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
