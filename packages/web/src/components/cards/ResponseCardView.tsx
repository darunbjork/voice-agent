import type { ResponseCard } from "@voice-agent/shared-types";
import { WeatherCard } from "./WeatherCard.js";
import { ReminderCard } from "./ReminderCard.js";
import { TranslateCard } from "./TranslateCard.js";
import { SummaryCard } from "./SummaryCard.js";
import { HelpCard } from "./HelpCard.js";

export type ResponseCardViewProps = {
  card: ResponseCard;
};

export function ResponseCardView({ card }: ResponseCardViewProps) {
  switch (card.type) {
    case "weather":
      return <WeatherCard card={card} />;
    case "reminder":
      return <ReminderCard card={card} />;
    case "translate":
      return <TranslateCard card={card} />;
    case "summary":
      return <SummaryCard card={card} />;
    case "help":
      return <HelpCard card={card} />;
    default: {
      const _exhaustive: never = card;
      return _exhaustive;
    }
  }
}
