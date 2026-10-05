import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { getPrisma, closePrisma } from "../utils/db.js";

async function prismaPlugin(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  await prisma.$connect();
  app.log.info("Prisma connected to Postgres");

  app.decorate("prisma", prisma);

  app.addHook("onClose", async (): Promise<void> => {
    await closePrisma();
    app.log.info("Prisma disconnected");
  });
}

export default fp(prismaPlugin, { name: "prisma" });
