import type { LatencyBreakdown } from "./audio.types.js";

export type IntentType =
  | "weather"
  | "reminder"
  | "translate"
  | "summarize"
  | "help"
  | "fallback";

export type WeatherCard = {
  type: "weather";
  icon: string; // emoji
  temp: string; // "22°C"
  desc: string;
  humidity: string;
  wind: string;
  location: string;
};

export type ReminderCard = {
  type: "reminder";
  note: string;
  time: string;
};

export type TranslateCard = {
  type: "translate";
  original: string;
  translated: string;
  fromLang: string;
  toLang: string;
};

export type SummaryCard = {
  type: "summary";
  points: string[];
  source: string;
};

export type HelpCard = {
  type: "help";
  commands: Array<{
    name: string;
    description: string;
  }>;
};

export type ResponseCard =
  | WeatherCard
  | ReminderCard
  | TranslateCard
  | SummaryCard
  | HelpCard;

export type AgentReply = {
  text: string;
  intent: IntentType;
  card: ResponseCard | null;
  latencyMs: LatencyBreakdown;
  sessionId: string;
  turnIndex: number;
};

export type GeminiAgentOutput = {
  reply: string;
  intent: IntentType;
  card: ResponseCard | null;
};
