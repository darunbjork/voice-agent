import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { env } from "../env.js";
import { clientIp } from "../config/client-ip.js";

// Admin routes allow 60 requests per minute per client. Without ADMIN_PASSWORD
// they answer 503, but the limiter runs first (onRequest), so 429 still shows.
const ADMIN_URL = "/api/v1/admin/usage";
const ADMIN_LIMIT = 60;
const originalFlyApp = env.FLY_APP_NAME;

let app: FastifyInstance | null = null;

afterEach(async () => {
  env.FLY_APP_NAME = originalFlyApp;
  await app?.close();
  app = null;
});

async function hitAdmin(times: number, headers: (i: number) => Record<string, string>) {
  app ??= await buildApp();
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await app.inject({ method: "GET", url: ADMIN_URL, headers: headers(i) });
    statuses.push(res.statusCode);
  }
  return statuses;
}

describe("rate limits are keyed on the real client, not on X-Forwarded-For", () => {
  it("a new spoofed X-Forwarded-For per request does not reset the admin limit", async () => {
    env.FLY_APP_NAME = "";
    const statuses = await hitAdmin(ADMIN_LIMIT + 1, (i) => ({
      "x-forwarded-for": `203.0.113.${i}`,
    }));
    expect(statuses.slice(0, ADMIN_LIMIT).every((s) => s !== 429)).toBe(true);
    expect(statuses[ADMIN_LIMIT]).toBe(429);
  });

  it("off Fly, a client-sent Fly-Client-IP header is ignored", async () => {
    env.FLY_APP_NAME = "";
    const statuses = await hitAdmin(ADMIN_LIMIT + 1, (i) => ({
      "fly-client-ip": `198.51.100.${i}`,
    }));
    expect(statuses[ADMIN_LIMIT]).toBe(429);
  });

  it("on Fly, the limit follows Fly-Client-IP whatever X-Forwarded-For says", async () => {
    env.FLY_APP_NAME = "darun-voice-agent-api";
    const statuses = await hitAdmin(ADMIN_LIMIT + 1, (i) => ({
      "fly-client-ip": "198.51.100.7",
      "x-forwarded-for": `203.0.113.${i}, 198.51.100.7`,
    }));
    expect(statuses[ADMIN_LIMIT]).toBe(429);
  });

  it("on Fly, a different real client gets its own budget", async () => {
    env.FLY_APP_NAME = "darun-voice-agent-api";
    await hitAdmin(ADMIN_LIMIT + 1, () => ({ "fly-client-ip": "198.51.100.7" }));
    const other = await hitAdmin(1, () => ({ "fly-client-ip": "198.51.100.8" }));
    expect(other[0]).not.toBe(429);
  });

  it("a rate-limited request answers 429 rate_limited with Retry-After, not 500", async () => {
    env.FLY_APP_NAME = "";
    await hitAdmin(ADMIN_LIMIT, () => ({}));
    const res = await app!.inject({ method: "GET", url: ADMIN_URL });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: "rate_limited" });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("the app no longer trusts X-Forwarded-For for request.ip", async () => {
    env.FLY_APP_NAME = "";
    app = await buildApp();
    app.get("/__ip", async (request) => ({ ip: clientIp(request), raw: request.ip }));
    const res = await app.inject({
      method: "GET",
      url: "/__ip",
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(res.json()).toEqual({ ip: "127.0.0.1", raw: "127.0.0.1" });
  });
});
