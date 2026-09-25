import type { FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

export async function correlationIdHook(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const existing = request.headers["x-correlation-id"];
  request.correlationId =
    typeof existing === "string" && existing.length > 0
      ? existing
      : randomUUID();
}
