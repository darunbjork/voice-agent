import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyHelmet from "@fastify/helmet";
import fastifyCors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import fastifyCsrf from "@fastify/csrf-protection";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import { env } from "./env.js";
import { correlationIdHook } from "./middleware/correlation-id.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { agentRoutes } from "./modules/agent/agent.routes.js";
import { BudgetExceededError } from "./utils/token-budget.js";
import prismaPlugin from "./plugins/prisma.plugin.js";
import redisPlugin from "./plugins/redis.plugin.js";
import { audioRoutes } from "./modules/audio/audio.routes.js";
import { initSentry } from "./sentry.js";
import { sessionRoutes } from "./modules/session/session.routes.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? {
            level: "debug",
            transport: {
              target: "pino-pretty",
              options: { colorize: true },
            },
          }
        : { level: env.NODE_ENV === "production" ? "info" : "debug" },
    trustProxy: true,
  });

  await app.register(fastifyHelmet, {
    global: true,
    contentSecurityPolicy: false,
  });

  await app.register(fastifyCors, {
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  await app.register(fastifyCookie, {
    secret: env.JWT_SECRET,
  });

  await app.register(fastifyCsrf, {
    cookieOpts: { signed: true },
  });

  await app.register(fastifyRateLimit, {
    max: 200,
    timeWindow: "1 minute",
  });

  await app.register(fastifyWebsocket);

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Voice Agent API",
        description: "Production voice agent – Darun Mustafa",
        version: "0.1.0",
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(prismaPlugin);
  await app.register(redisPlugin);

  app.addHook("onRequest", correlationIdHook);

  app.setErrorHandler<FastifyError>(async (err, request, reply) => {
    if (err instanceof BudgetExceededError) {
      await reply.status(429).header("Retry-After", "3600").send({
        error: "budget_exceeded",
        message: err.message,
        correlationId: request.correlationId,
      });
      return;
    }
    if (err.validation !== undefined) {
      await reply.status(400).send({
        error: "validation_error",
        message: err.message,
        correlationId: request.correlationId,
      });
      return;
    }
    request.log.error({ err }, "unhandled error");
    await reply.status(500).send({
      error: "internal",
      message: "Internal server error",
      correlationId: request.correlationId,
    });
  });

  await app.register(healthRoutes);
  await app.register(agentRoutes);
  await app.register(audioRoutes);
  await app.register(sessionRoutes);
  await app.register(adminRoutes);

  return app;
}

async function start(): Promise<void> {
  initSentry();

  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`Voice Agent API listening on http://localhost:${env.PORT}`);
    app.log.info(`Swagger UI → http://localhost:${env.PORT}/docs`);
    app.log.info(`Health     → http://localhost:${env.PORT}/health`);
    app.log.info(`VOICE_MOCK = ${env.VOICE_MOCK}`);
    app.log.info(env.SENTRY_DSN ? "Sentry enabled" : "Sentry disabled (no SENTRY_DSN)");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void start();
}
