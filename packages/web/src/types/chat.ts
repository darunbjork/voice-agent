import type { IntentType, ResponseCard } from "@voice-agent/shared-types";

export type ChatRole = "user" | "agent";

export type ChatMessageModel = {
  id: string;
  role: ChatRole;
  text: string;
  card?: ResponseCard | null;
  intent?: IntentType;
  turnIndex?: number;
  sessionId?: string;
  createdAt: string;
};
