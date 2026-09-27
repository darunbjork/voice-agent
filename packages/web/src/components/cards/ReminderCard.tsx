import type { ReminderCard as ReminderCardType } from "@voice-agent/shared-types";
import { CARD_ACCENT, cardBodyPad, cardShell, cardTitle, cardTitleRow } from "./cardShared.js";
import { useCardEntrance } from "./useCardEntrance.js";

export type ReminderCardProps = {
  card: ReminderCardType;
};

export function ReminderCard({ card }: ReminderCardProps) {
  const ref = useCardEntrance<HTMLElement>();
  const accent = CARD_ACCENT.reminder;

  return (
    <article
      ref={ref}
      style={cardShell(accent)}
      aria-label={`Reminder: ${card.note}, ${card.time}`}
    >
      <div style={{ height: 3, background: accent }} />
      <div style={cardBodyPad}>
        <div style={cardTitleRow}>
          <span style={{ fontSize: 20 }} aria-hidden>
            ⏰
          </span>
          <span style={cardTitle}>Reminder</span>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          {card.note}
        </p>
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 13,
            color: "var(--ember-soft)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {card.time}
        </p>
      </div>
    </article>
  );
}
