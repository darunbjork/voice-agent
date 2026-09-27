import type { HelpCard as HelpCardType } from "@voice-agent/shared-types";
import { CARD_ACCENT, cardBodyPad, cardShell, cardTitle, cardTitleRow } from "./cardShared.js";
import { useCardEntrance } from "./useCardEntrance.js";

export type HelpCardProps = {
  card: HelpCardType;
};

export function HelpCard({ card }: HelpCardProps) {
  const ref = useCardEntrance<HTMLElement>();
  const accent = CARD_ACCENT.help;

  return (
    <article ref={ref} style={cardShell(accent)} aria-label="Available commands">
      <div style={{ height: 3, background: accent }} />
      <div style={cardBodyPad}>
        <div style={cardTitleRow}>
          <span style={{ fontSize: 20 }} aria-hidden>
            ✨
          </span>
          <span style={cardTitle}>Commands</span>
        </div>
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {card.commands.map((cmd) => (
            <li
              key={cmd.name}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: 10,
                alignItems: "start",
              }}
            >
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--iris-soft)",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  padding: "3px 7px",
                  borderRadius: 6,
                }}
              >
                {cmd.name}
              </code>
              <span style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.4 }}>
                {cmd.description}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
