import type { createClient } from "redis";

import { DAILY_MAX_TOKENS } from "./token-budget.js";

type AppRedisClient = ReturnType<typeof createClient>;

export type UsageSnapshot = {
  date: string;
  tokens: number;
  ttsChars: number;
  sttSeconds: number;
};

const memoryStore = new Map<string, UsageSnapshot>();
let boundRedis: AppRedisClient | null = null;

export function bindRedis(client: AppRedisClient): void {
  boundRedis = client;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function redisKey(date: string): string {
  return `voice:usage:${date}`;
}

function emptySnapshot(date: string): UsageSnapshot {
  return { date, tokens: 0, ttsChars: 0, sttSeconds: 0 };
}

export async function getDailyUsage(): Promise<UsageSnapshot> {
  const date = todayKey();

  if (boundRedis !== null) {
    const raw = await boundRedis.hGetAll(redisKey(date));
    if (raw !== null && Object.keys(raw).length > 0) {
      return {
        date,
        tokens: Number(raw.tokens ?? 0),
        ttsChars: Number(raw.ttsChars ?? 0),
        sttSeconds: Number(raw.sttSeconds ?? 0),
      };
    }
  }

  return memoryStore.get(date) ?? emptySnapshot(date);
}

export async function incrementUsage(delta: {
  tokens?: number;
  ttsChars?: number;
  sttSeconds?: number;
}): Promise<UsageSnapshot> {
  const date = todayKey();

  if (boundRedis !== null) {
    const key = redisKey(date);
    await boundRedis
      .multi()
      .hIncrBy(key, "tokens", delta.tokens ?? 0)
      .hIncrBy(key, "ttsChars", delta.ttsChars ?? 0)
      .hIncrBy(key, "sttSeconds", delta.sttSeconds ?? 0)
      .expire(key, 172800)
      .exec();
    return getDailyUsage();
  }

  const current = memoryStore.get(date) ?? emptySnapshot(date);
  const updated: UsageSnapshot = {
    date,
    tokens: current.tokens + (delta.tokens ?? 0),
    ttsChars: current.ttsChars + (delta.ttsChars ?? 0),
    sttSeconds: current.sttSeconds + (delta.sttSeconds ?? 0),
  };
  memoryStore.set(date, updated);
  return updated;
}

export async function isApproachingDailyLimit(): Promise<boolean> {
  const usage = await getDailyUsage();
  return usage.tokens >= DAILY_MAX_TOKENS * 0.8;
}