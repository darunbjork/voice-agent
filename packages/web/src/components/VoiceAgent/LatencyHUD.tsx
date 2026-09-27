import type { LatencyBreakdown } from "@voice-agent/shared-types";

export type LatencyHUDProps = {
  latency: LatencyBreakdown | null;
  label?: string;
};

type MetricKey = keyof LatencyBreakdown;

const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: "stt", label: "STT" },
  { key: "llm", label: "LLM" },
  { key: "tts", label: "TTS" },
  { key: "total", label: "Total" },
];

function formatMs(value: number | null | undefined, isPending: boolean): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (isPending && value === 0) return "—";
  if (value < 1000) return `${Math.round(value)}`;
  return `${(value / 1000).toFixed(2)}s`;
}

function totalColor(total: number | null): string {
  if (total === null || total === 0) return "var(--muted)";
  if (total < 500) return "var(--success)";
  if (total < 1000) return "var(--ember)";
  return "var(--error)";
}

export function LatencyHUD({ latency, label = "Latency" }: LatencyHUDProps) {
  const total = latency?.total ?? null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={
        latency
          ? `Latency STT ${latency.stt} milliseconds, LLM ${latency.llm}, TTS ${latency.tts}, total ${latency.total}`
          : "Latency unavailable"
      }
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 6,
        padding: "0.55rem 0.65rem",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        marginBottom: "0.85rem",
      }}
    >
      <div
        style={{
          gridColumn: "1 / -1",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginBottom: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>{label}</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            color: totalColor(total),
            fontSize: 11,
          }}
        >
          {total !== null && total > 0 ? `${Math.round(total)} ms` : "—"}
        </span>
      </div>

      {METRICS.map(({ key, label: metricLabel }) => {
        const value = latency?.[key] ?? null;
        const isTotal = key === "total";
        const isPending = key === "tts";
        return (
          <div
            key={key}
            style={{
              textAlign: "center",
              padding: "0.35rem 0.15rem",
              borderRadius: 6,
              background: isTotal ? "rgba(124, 58, 237, 0.1)" : "transparent",
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--muted)",
                marginBottom: 2,
              }}
            >
              {metricLabel}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: isTotal ? 700 : 500,
                color: isTotal ? totalColor(value) : "var(--text)",
              }}
            >
              {formatMs(value, isPending)}
              {value !== null && value > 0 && value < 1000 && (
                <span style={{ fontSize: 9, color: "var(--muted)" }}> ms</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
