import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { createClient } from "redis";
import { env } from "../env.js";
import { bindRedis } from "../utils/usage-tracker.js";

async function redisPlugin(app: FastifyInstance): Promise<void> {
  // REDIS_URL is optional. Deploys without a Redis add-on skip the client;
  // usage-tracker falls back to its in-memory store.
  if (!env.REDIS_URL) {
    app.log.info("REDIS_URL not set — running without Redis");
    return;
  }

  const redis = createClient({ url: env.REDIS_URL });

  redis.on("error", (err: Error): void => {
    app.log.error({ err }, "Redis client error");
  });

  try {
    await redis.connect();
    app.decorate("redis", redis);
    bindRedis(redis);
    app.log.info("Redis connected");

    app.addHook("onClose", async (): Promise<void> => {
      await redis.quit();
      app.log.info("Redis disconnected");
    });
  } catch (err) {
    app.log.warn({ err }, "Redis unavailable — running without cache");
  }
}

export default fp(redisPlugin, { name: "redis" });
