import type { WeatherCard as WeatherCardType } from "@voice-agent/shared-types";
import { CARD_ACCENT, cardBodyPad, cardShell, cardTitle, cardTitleRow } from "./cardShared.js";
import { useCardEntrance } from "./useCardEntrance.js";

export type WeatherCardProps = {
  card: WeatherCardType;
};

export function WeatherCard({ card }: WeatherCardProps) {
  const ref = useCardEntrance<HTMLElement>();
  const accent = CARD_ACCENT.weather;

  return (
    <article
      ref={ref}
      style={cardShell(accent)}
      aria-label={`Weather in ${card.location}: ${card.temp}, ${card.desc}`}
    >
      <div style={{ height: 3, background: accent }} />
      <div style={cardBodyPad}>
        <div style={cardTitleRow}>
          <span style={{ fontSize: 26 }} aria-hidden>
            {card.icon}
          </span>
          <span style={cardTitle}>Weather · {card.location}</span>
        </div>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
          }}
        >
          {card.temp}
        </div>
        <div style={{ color: "var(--muted)", fontSize: 14, marginTop: 4 }}>{card.desc}</div>
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 12,
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          <span>💧 {card.humidity}</span>
          <span>💨 {card.wind}</span>
        </div>
      </div>
    </article>
  );
}
