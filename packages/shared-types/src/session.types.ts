import type { IntentType } from "./agent.types.js";
import type { LatencyBreakdown } from "./audio.types.js";

export type VoiceSessionSummary = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  totalTokens: number;
  language: string;
};

export type ConversationTurn = {
  id: string;
  sessionId: string;
  turnIndex: number;
  userTranscript: string;
  agentReply: string;
  intentType: IntentType;
  cardType: IntentType | null;
  latency: LatencyBreakdown | null;
  tokenCount: number;
  createdAt: string;
};

export type SessionDetail = VoiceSessionSummary & {
  turns: ConversationTurn[];
};

export type DailyUsage = {
  date: string;
  tokens: number;
  ttsChars: number;
  sttSeconds: number;
};
