export const SHARED_TYPES_VERSION = "0.0.2" as const;

export type { HealthStatus } from "./legacy.js";

export type { ClientAudioMessage, ServerAudioMessage, LatencyBreakdown } from "./audio.types.js";

export type {
  IntentType,
  WeatherCard,
  ReminderCard,
  TranslateCard,
  SummaryCard,
  HelpCard,
  ResponseCard,
  AgentReply,
  GeminiAgentOutput,
} from "./agent.types.js";

export type {
  VoiceSessionSummary,
  ConversationTurn,
  SessionDetail,
  DailyUsage,
} from "./session.types.js";

export type {
  WeatherCard as WeatherCardType,
  ReminderCard as ReminderCardType,
  TranslateCard as TranslateCardType,
  SummaryCard as SummaryCardType,
  HelpCard as HelpCardType,
  ResponseCard as ResponseCardType,
} from "./card.types.js";
