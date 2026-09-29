import type { LatencyBreakdown } from "@voice-agent/shared-types";

export type LatencyStage = "stt" | "llm" | "tts";

export type LatencyHUDProps = {
  latency: LatencyBreakdown | null;
  stage?: LatencyStage | null;
  label?: string;
};

type MetricKey = keyof LatencyBreakdown;

const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: "stt", label: "STT" },
  { key: "llm", label: "LLM" },
  { key: "tts", label: "TTS" },
  { key: "total", label: "Total" },
];

const STAGE_LABEL: Record<LatencyStage, string> = {
  stt: "Listening · transcribing",
  llm: "Generating reply",
  tts: "Streaming voice",
};

const STAGE_COLOR: Record<LatencyStage, string> = {
  stt: "var(--success)",
  llm: "var(--ember)",
  tts: "var(--iris-soft)",
};

const THRESHOLDS: Record<MetricKey, readonly [number, number]> = {
  stt: [350, 800],
  llm: [900, 1800],
  tts: [450, 1000],
  total: [1000, 2000],
};

function hasValue(value: number | null | undefined): value is number {
  return typeof value === "number" && !Number.isNaN(value) && value > 0;
}

function metricColor(key: MetricKey, value: number | null | undefined): string | undefined {
  if (!hasValue(value)) return undefined;
  const [fast, acceptable] = THRESHOLDS[key];
  if (value <= fast) return "var(--success)";
  if (value <= acceptable) return "var(--ember)";
  return "var(--error)";
}

function qualityWord(total: number): string {
  const [fast, acceptable] = THRESHOLDS.total;
  if (total <= fast) return "Fast";
  if (total <= acceptable) return "OK";
  return "Slow";
}

function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function StageDots() {
  return (
    <span className="stage-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function describe(
  latency: LatencyBreakdown | null,
  stage: LatencyStage | null | undefined,
): string {
  if (!latency && !stage) return "Latency: waiting for the first request";
  const parts = METRICS.map(({ key, label }) => {
    const value = latency?.[key] ?? null;
    return hasValue(value) ? `${label} ${Math.round(value)} milliseconds` : `${label} pending`;
  });
  const active = stage ? `. In progress: ${STAGE_LABEL[stage]}` : "";
  return `Latency. ${parts.join(", ")}${active}`;
}

export function LatencyHUD({ latency, stage = null, label = "Latency" }: LatencyHUDProps) {
  const total = latency?.total ?? null;
  const totalColor = metricColor("total", total);
  const stageCaption = stage ? STAGE_LABEL[stage] : null;

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label={describe(latency, stage)}
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
          gap: 8,
        }}
      >
        <span>{label}</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            textTransform: "none",
            letterSpacing: 0,
            fontWeight: 500,
            color: stageCaption
              ? (STAGE_COLOR[stage as LatencyStage] ?? "var(--muted)")
              : "var(--muted)",
          }}
        >
          {stageCaption ? (
            <>
              <StageDots />
              {stageCaption}
            </>
          ) : hasValue(total) ? (
            <>
              <span style={{ color: totalColor }}>{formatMs(total)}</span>
              <span style={{ color: totalColor }}>· {qualityWord(total)}</span>
            </>
          ) : (
            "Waiting for a request"
          )}
        </span>
      </div>

      {METRICS.map(({ key, label: metricLabel }) => {
        const value = latency?.[key] ?? null;
        const isTotal = key === "total";
        const isStageActive = key === stage;
        const color = metricColor(key, value);

        return (
          <div
            key={key}
            style={{
              textAlign: "center",
              padding: "0.35rem 0.15rem",
              borderRadius: 6,
              background: isTotal
                ? "rgba(124, 58, 237, 0.1)"
                : isStageActive
                  ? "rgba(255, 255, 255, 0.05)"
                  : "transparent",
              transition: "background 160ms ease",
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: isStageActive ? STAGE_COLOR[stage as LatencyStage] : "var(--muted)",
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
                color:
                  color ?? (isStageActive ? STAGE_COLOR[stage as LatencyStage] : "var(--muted)"),
                minHeight: 18,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
              }}
            >
              {hasValue(value) ? formatMs(value) : isStageActive ? <StageDots /> : "—"}
            </div>
          </div>
        );
      })}
    </section>
  );
}
