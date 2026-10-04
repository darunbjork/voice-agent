import { PrismaClient } from "../generated/prisma/index.js";

let client: PrismaClient | undefined;

/** Shared lazy singleton so tool handlers and Fastify routes use one pool. */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
  }
  return client;
}

export async function closePrisma(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = undefined;
}
