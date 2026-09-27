import type { TranslateCard as TranslateCardType } from "@voice-agent/shared-types";
import { CARD_ACCENT, cardBodyPad, cardShell, cardTitle, cardTitleRow } from "./cardShared.js";
import { useCardEntrance } from "./useCardEntrance.js";

export type TranslateCardProps = {
  card: TranslateCardType;
};

export function TranslateCard({ card }: TranslateCardProps) {
  const ref = useCardEntrance<HTMLElement>();
  const accent = CARD_ACCENT.translate;

  return (
    <article
      ref={ref}
      style={cardShell(accent)}
      aria-label={`Translation from ${card.fromLang} to ${card.toLang}`}
    >
      <div style={{ height: 3, background: accent }} />
      <div style={cardBodyPad}>
        <div style={cardTitleRow}>
          <span style={{ fontSize: 20 }} aria-hidden>
            🌐
          </span>
          <span style={cardTitle}>
            {card.fromLang} → {card.toLang}
          </span>
        </div>
        <div
          style={{
            padding: "0.5rem 0.65rem",
            borderRadius: "var(--radius-sm)",
            background: "var(--surface-2)",
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: 2,
            }}
          >
            Original
          </div>
          <div style={{ fontSize: 14 }}>{card.original}</div>
        </div>
        <div
          style={{
            padding: "0.5rem 0.65rem",
            borderRadius: "var(--radius-sm)",
            background: "rgba(167, 139, 250, 0.12)",
            border: "1px solid rgba(167, 139, 250, 0.25)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--iris-soft)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: 2,
            }}
          >
            Translated
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{card.translated}</div>
        </div>
      </div>
    </article>
  );
}
