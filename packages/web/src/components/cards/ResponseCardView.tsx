import type { CSSProperties } from "react";
import type { ResponseCard } from "@voice-agent/shared-types";

export type ResponseCardViewProps = {
  card: ResponseCard;
};

const CARD_ACCENT: Record<ResponseCard["type"], string> = {
  weather: "#38bdf8",
  reminder: "#f59e0b",
  translate: "#a78bfa",
  summary: "#22c55e",
  help: "#94a3b8",
};

export function ResponseCardView({ card }: ResponseCardViewProps) {
  const accent = CARD_ACCENT[card.type];

  return (
    <div
      style={{
        marginTop: 8,
        borderRadius: "var(--radius-md)",
        border: `1px solid ${accent}33`,
        background: "var(--surface)",
        overflow: "hidden",
      }}
    >
      <div style={{ height: 3, background: accent }} />
      <div style={{ padding: "0.75rem 0.9rem" }}>
        {card.type === "weather" && <WeatherBody card={card} />}
        {card.type === "reminder" && <ReminderBody card={card} />}
        {card.type === "translate" && <TranslateBody card={card} />}
        {card.type === "summary" && <SummaryBody card={card} />}
        {card.type === "help" && <HelpBody card={card} />}
      </div>
    </div>
  );
}

function WeatherBody({ card }: { card: Extract<ResponseCard, { type: "weather" }> }) {
  return (
    <div>
      <div style={titleRow}>
        <span style={{ fontSize: 22 }}>{card.icon}</span>
        <span style={titleStyle}>Weather · {card.location}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, margin: "0.35rem 0" }}>{card.temp}</div>
      <div style={{ color: "var(--muted)", fontSize: 13 }}>{card.desc}</div>
      <div style={metaRow}>
        <span>Humidity {card.humidity}</span>
        <span>Wind {card.wind}</span>
      </div>
    </div>
  );
}

function ReminderBody({ card }: { card: Extract<ResponseCard, { type: "reminder" }> }) {
  return (
    <div>
      <div style={titleRow}>
        <span style={{ fontSize: 18 }}>⏰</span>
        <span style={titleStyle}>Reminder</span>
      </div>
      <div style={{ fontSize: 15, marginTop: 6 }}>{card.note}</div>
      <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>{card.time}</div>
    </div>
  );
}

function TranslateBody({ card }: { card: Extract<ResponseCard, { type: "translate" }> }) {
  return (
    <div>
      <div style={titleRow}>
        <span style={{ fontSize: 18 }}>🌐</span>
        <span style={titleStyle}>
          Translate · {card.fromLang} → {card.toLang}
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        <div style={{ color: "var(--muted)", fontSize: 12 }}>{card.original}</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>{card.translated}</div>
      </div>
    </div>
  );
}

function SummaryBody({ card }: { card: Extract<ResponseCard, { type: "summary" }> }) {
  return (
    <div>
      <div style={titleRow}>
        <span style={{ fontSize: 18 }}>📋</span>
        <span style={titleStyle}>Summary</span>
      </div>
      <ul style={{ margin: "8px 0 0", paddingLeft: "1.1rem", fontSize: 13 }}>
        {card.points.map((p, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            {p}
          </li>
        ))}
      </ul>
      <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 6 }}>Source: {card.source}</div>
    </div>
  );
}

function HelpBody({ card }: { card: Extract<ResponseCard, { type: "help" }> }) {
  return (
    <div>
      <div style={titleRow}>
        <span style={{ fontSize: 18 }}>✨</span>
        <span style={titleStyle}>Commands</span>
      </div>
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
        {card.commands.map((c) => (
          <li key={c.name} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 13 }}>
            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--iris-soft)",
                background: "var(--surface-2)",
                padding: "2px 6px",
                borderRadius: 4,
                flexShrink: 0,
              }}
            >
              {c.name}
            </code>
            <span style={{ color: "var(--muted)" }}>{c.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const titleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const titleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--muted)",
};

const metaRow: CSSProperties = {
  display: "flex",
  gap: 16,
  marginTop: 8,
  fontSize: 12,
  color: "var(--muted)",
};
