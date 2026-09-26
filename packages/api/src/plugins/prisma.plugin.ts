import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "../generated/prisma/index.js";

async function prismaPlugin(app: FastifyInstance): Promise<void> {
  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  await prisma.$connect();
  app.log.info("Prisma connected to Postgres");

  app.decorate("prisma", prisma);

  app.addHook("onClose", async (): Promise<void> => {
    await prisma.$disconnect();
    app.log.info("Prisma disconnected");
  });
}

export default fp(prismaPlugin, { name: "prisma" });
