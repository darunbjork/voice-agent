import type { createClient } from "redis";
import * as Sentry from "@sentry/node";

import { DAILY_MAX_TOKENS } from "./token-budget.js";
import { env } from "../env.js";

type AppRedisClient = ReturnType<typeof createClient>;

export type UsageSnapshot = {
  date: string;
  tokens: number;
  ttsChars: number;
  sttSeconds: number;
};

const memoryStore = new Map<string, UsageSnapshot>();
const alertedDates = new Set<string>();
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
    try {
      const raw = await boundRedis.hGetAll(redisKey(date));
      if (raw !== null && Object.keys(raw).length > 0) {
        return {
          date,
          tokens: Number(raw.tokens ?? 0),
          ttsChars: Number(raw.ttsChars ?? 0),
          sttSeconds: Number(raw.sttSeconds ?? 0),
        };
      }
    } catch {}
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
    try {
      const key = redisKey(date);
      await boundRedis
        .multi()
        .hIncrBy(key, "tokens", delta.tokens ?? 0)
        .hIncrBy(key, "ttsChars", delta.ttsChars ?? 0)
        .hIncrBy(key, "sttSeconds", delta.sttSeconds ?? 0)
        .expire(key, 172800)
        .exec();
      const updated = await getDailyUsage();
      await maybeAlert(updated);
      return updated;
    } catch {}
  }

  const current = memoryStore.get(date) ?? emptySnapshot(date);
  const updated: UsageSnapshot = {
    date,
    tokens: current.tokens + (delta.tokens ?? 0),
    ttsChars: current.ttsChars + (delta.ttsChars ?? 0),
    sttSeconds: current.sttSeconds + (delta.sttSeconds ?? 0),
  };
  memoryStore.set(date, updated);
  await maybeAlert(updated);
  return updated;
}

export async function isApproachingDailyLimit(): Promise<boolean> {
  const usage = await getDailyUsage();
  return usage.tokens >= DAILY_MAX_TOKENS * 0.8;
}

async function maybeAlert(usage: UsageSnapshot): Promise<void> {
  if (usage.tokens < DAILY_MAX_TOKENS * 0.8) return;
  if (alertedDates.has(usage.date)) return;

  alertedDates.add(usage.date);

  const pct = Math.round((usage.tokens / DAILY_MAX_TOKENS) * 100);
  const message = `[Voice Agent] Daily token usage at ${pct}% (${usage.tokens}/${DAILY_MAX_TOKENS})`;

  console.warn(
    JSON.stringify({
      level: "warn",
      msg: message,
      alert: "daily_token_80pct",
      usage,
      dailyMax: DAILY_MAX_TOKENS,
    }),
  );

  if (env.SENTRY_DSN) {
    Sentry.captureMessage(message, {
      level: "warning",
      tags: { component: "usage-tracker" },
      extra: { usage, dailyMax: DAILY_MAX_TOKENS },
    });
  }
}

export function resetUsageMemory(): void {
  memoryStore.clear();
  alertedDates.clear();
}

export function hasAlertedToday(): boolean {
  return alertedDates.has(todayKey());
}
