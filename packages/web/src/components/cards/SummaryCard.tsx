import type { SummaryCard as SummaryCardType } from "@voice-agent/shared-types";
import { CARD_ACCENT, cardBodyPad, cardShell, cardTitle, cardTitleRow } from "./cardShared.js";
import { useCardEntrance } from "./useCardEntrance.js";

export type SummaryCardProps = {
  card: SummaryCardType;
};

export function SummaryCard({ card }: SummaryCardProps) {
  const ref = useCardEntrance<HTMLElement>();
  const accent = CARD_ACCENT.summary;

  return (
    <article
      ref={ref}
      style={cardShell(accent)}
      aria-label={`Summary with ${card.points.length} points`}
    >
      <div style={{ height: 3, background: accent }} />
      <div style={cardBodyPad}>
        <div style={cardTitleRow}>
          <span style={{ fontSize: 20 }} aria-hidden>
            📋
          </span>
          <span style={cardTitle}>Summary</span>
        </div>
        <ol
          style={{
            margin: 0,
            paddingLeft: "1.2rem",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {card.points.map((point, i) => (
            <li key={i} style={{ marginBottom: 6 }}>
              {point}
            </li>
          ))}
        </ol>
        <div
          style={{
            marginTop: 10,
            fontSize: 11,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            borderTop: "1px solid var(--border)",
            paddingTop: 8,
          }}
        >
          Source: {card.source}
        </div>
      </div>
    </article>
  );
}
