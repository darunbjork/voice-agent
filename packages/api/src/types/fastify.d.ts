import "fastify";
import type { PrismaClient } from "../generated/prisma/index.js";
import type { createClient } from "redis";

type AppRedisClient = ReturnType<typeof createClient>;

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis?: AppRedisClient;
  }
  interface FastifyRequest {
    correlationId: string;
  }
}