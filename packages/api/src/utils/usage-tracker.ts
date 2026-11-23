import type { createClient } from "redis";
import * as Sentry from "@sentry/node";

import { getDailyLimits } from "./token-budget.js";
import { env } from "../env.js";

type AppRedisClient = ReturnType<typeof createClient>;

export type UsageSnapshot = {
  date: string;
  tokens: number;
  ttsChars: number;
  sttSeconds: number;
};

/**
 * Daily counters (UTC day). With REDIS_URL they live in Redis, so they survive
 * restarts (Fly stops idle machines) and are shared by every machine. Without
 * Redis they are per process: each machine run starts again at zero.
 */
const memoryStore = new Map<string, UsageSnapshot>();
const alertedDates = new Set<string>();
let boundRedis: AppRedisClient | null = null;
let keyPrefix = "voice";
/** Set while Redis is failing, so the fallback warning is logged once per outage. */
let redisFailing = false;

/** Two days, so yesterday's counters can still be read around midnight UTC. */
const KEY_TTL_SECONDS = 172_800;

export function bindRedis(client: AppRedisClient, options: { keyPrefix?: string } = {}): void {
  boundRedis = client;
  keyPrefix = options.keyPrefix ?? "voice";
}

export function unbindRedis(): void {
  boundRedis = null;
  keyPrefix = "voice";
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(date: string): string {
  return `${keyPrefix}:usage:${date}`;
}

function alertKey(date: string): string {
  return `${keyPrefix}:alert:daily_token_80pct:${date}`;
}

function emptySnapshot(date: string): UsageSnapshot {
  return { date, tokens: 0, ttsChars: 0, sttSeconds: 0 };
}

function redisFailed(err: unknown, op: string): void {
  if (redisFailing) return;
  redisFailing = true;
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "Redis usage counter unavailable — using this machine's in-memory counters",
      alert: "usage_redis_fallback",
      op,
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}

export async function getDailyUsage(): Promise<UsageSnapshot> {
  const date = todayKey();

  if (boundRedis !== null) {
    try {
      const raw = await boundRedis.hGetAll(usageKey(date));
      redisFailing = false;
      if (raw !== null && Object.keys(raw).length > 0) {
        return {
          date,
          tokens: Number(raw.tokens ?? 0),
          ttsChars: Number(raw.ttsChars ?? 0),
          sttSeconds: Number(raw.sttSeconds ?? 0),
        };
      }
    } catch (err) {
      redisFailed(err, "read");
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
    try {
      const key = usageKey(date);
      // One MULTI: the totals returned are the ones this increment produced.
      const [tokens, ttsChars, sttSeconds] = (await boundRedis
        .multi()
        .hIncrBy(key, "tokens", delta.tokens ?? 0)
        .hIncrBy(key, "ttsChars", delta.ttsChars ?? 0)
        .hIncrBy(key, "sttSeconds", delta.sttSeconds ?? 0)
        .expire(key, KEY_TTL_SECONDS)
        .exec()) as unknown as [number, number, number, boolean];
      redisFailing = false;
      const updated: UsageSnapshot = {
        date,
        tokens: Number(tokens),
        ttsChars: Number(ttsChars),
        sttSeconds: Number(sttSeconds),
      };
      await maybeAlert(updated);
      return updated;
    } catch (err) {
      redisFailed(err, "increment");
    }
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
  return usage.tokens >= getDailyLimits().tokens * 0.8;
}

/** True the first time today's alert is claimed: in Redis across machines, else per process. */
async function claimAlert(date: string): Promise<boolean> {
  if (alertedDates.has(date)) return false;
  alertedDates.add(date);
  if (boundRedis === null) return true;
  try {
    const set = await boundRedis.set(alertKey(date), "1", { NX: true, EX: KEY_TTL_SECONDS });
    return set === "OK";
  } catch (err) {
    redisFailed(err, "alert");
    return true;
  }
}

async function maybeAlert(usage: UsageSnapshot): Promise<void> {
  const DAILY_MAX_TOKENS = getDailyLimits().tokens;
  if (usage.tokens < DAILY_MAX_TOKENS * 0.8) return;
  if (!(await claimAlert(usage.date))) return;

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
  redisFailing = false;
}

export function hasAlertedToday(): boolean {
  return alertedDates.has(todayKey());
}
