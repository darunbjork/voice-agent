// With REDIS_URL, every daily counter lives in Redis: it survives a restart
// (Fly stops idle machines) and is shared by every machine. Runs against the
// local Redis from docker compose / the CI service; skipped without REDIS_URL.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { envSchema } from "../env.js";
import {
  bindRedis,
  unbindRedis,
  getDailyUsage,
  incrementUsage,
  resetUsageMemory,
} from "../utils/usage-tracker.js";
import { getDailyLimits } from "../utils/token-budget.js";

const REDIS_URL = process.env.REDIS_URL;
type Client = ReturnType<typeof createClient>;

/** One Redis connection per simulated machine; keys under a per-test prefix. */
const clients: Client[] = [];
let prefix = "";

async function machine(): Promise<Client> {
  const c = createClient({ url: REDIS_URL });
  await c.connect();
  clients.push(c);
  return c;
}

/** A process restart: in-memory state is gone, Redis is not. */
async function restart(): Promise<void> {
  resetUsageMemory();
  bindRedis(await machine(), { keyPrefix: prefix });
}

describe.skipIf(!REDIS_URL)("daily counters in Redis", () => {
  beforeEach(async () => {
    prefix = `test:${randomUUID()}`;
    resetUsageMemory();
    bindRedis(await machine(), { keyPrefix: prefix });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const c = clients[0];
    if (c) {
      const keys = await c.keys(`${prefix}:*`);
      if (keys.length > 0) await c.del(keys);
    }
    unbindRedis();
    resetUsageMemory();
    await Promise.all(clients.splice(0).map((c) => c.quit()));
  });

  afterAll(() => {
    unbindRedis();
  });

  it("tokens, TTS characters and STT seconds survive a restart", async () => {
    await incrementUsage({ tokens: 120, ttsChars: 300, sttSeconds: 45 });
    await restart();
    expect(await getDailyUsage()).toMatchObject({ tokens: 120, ttsChars: 300, sttSeconds: 45 });
  });

  it("two machines share one total", async () => {
    const a = await machine();
    const b = await machine();
    bindRedis(a, { keyPrefix: prefix });
    await incrementUsage({ tokens: 100 });
    bindRedis(b, { keyPrefix: prefix });
    await incrementUsage({ tokens: 50, ttsChars: 10 });
    expect(await getDailyUsage()).toMatchObject({ tokens: 150, ttsChars: 10 });
  });

  it("concurrent increments are not lost", async () => {
    await Promise.all(Array.from({ length: 50 }, () => incrementUsage({ tokens: 2 })));
    expect((await getDailyUsage()).tokens).toBe(100);
  });

  it("the 80% alert fires once per day across restarts and machines", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const alerts = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes("daily_token_80pct")).length;

    await incrementUsage({ tokens: Math.ceil(getDailyLimits().tokens * 0.8) });
    expect(alerts()).toBe(1);

    await restart();
    await incrementUsage({ tokens: 10 });
    await restart();
    await incrementUsage({ tokens: 10 });
    expect(alerts()).toBe(1);
  });

  it("a Redis failure falls back to memory and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = await machine();
    await broken.quit();
    clients.splice(clients.indexOf(broken), 1);
    bindRedis(broken, { keyPrefix: prefix });

    const usage = await incrementUsage({ tokens: 7 });
    expect(usage.tokens).toBe(7);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("usage_redis_fallback"))).toBe(true);
  });
});

describe("REDIS_URL validation", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    JWT_SECRET: "x".repeat(32),
  };
  it.each(["redis://localhost:6379", "rediss://default:pw@eu1-host.upstash.io:6379"])(
    "accepts %s",
    (url) => {
      expect(envSchema.safeParse({ ...base, REDIS_URL: url }).success).toBe(true);
    },
  );
});
