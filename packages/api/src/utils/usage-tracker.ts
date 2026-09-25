// packages/api/src/utils/usage-tracker.ts
// Daily usage counter. In-memory for Day 4; documented swap to Redis on Day 5.

import { DAILY_MAX_TOKENS } from "./token-budget.js";

export type UsageSnapshot = {
  date: string; // YYYY-MM-DD
  tokens: number;
  ttsChars: number;
  sttSeconds: number;
};

const memoryStore = new Map<string, UsageSnapshot>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyUsage(): UsageSnapshot {
  const key = todayKey();
  return memoryStore.get(key) ?? {
    date: key,
    tokens: 0,
    ttsChars: 0,
    sttSeconds: 0,
  };
}

// TODO(Day 5): Redis INCRBY — atomic, cross-replica.
// Today's in-memory store loses writes across replicas and would
// lose writes across concurrent awaits if this were async. It isn't.
export function incrementUsage(delta: {
  tokens?: number;
  ttsChars?: number;
  sttSeconds?: number;
}): UsageSnapshot {
  const current = getDailyUsage();
  const updated: UsageSnapshot = {
    date: current.date,
    tokens: current.tokens + (delta.tokens ?? 0),
    ttsChars: current.ttsChars + (delta.ttsChars ?? 0),
    sttSeconds: current.sttSeconds + (delta.sttSeconds ?? 0),
  };
  memoryStore.set(current.date, updated);
  return updated;
}

export function isApproachingDailyLimit(): boolean {
  return getDailyUsage().tokens >= DAILY_MAX_TOKENS * 0.8;
}
