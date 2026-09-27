import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

function unauthorized(reply: FastifyReply): void {
  void reply
    .status(401)
    .header("WWW-Authenticate", 'Basic realm="Voice Agent Admin"')
    .send({ error: "unauthorized" });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function basicAuthGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!env.ADMIN_PASSWORD) {
    await reply.status(503).send({
      error: "admin_disabled",
      message: "ADMIN_PASSWORD is not configured.",
    });
    return;
  }

  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) {
    unauthorized(reply);
    return;
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) {
    unauthorized(reply);
    return;
  }

  const password = decoded.slice(sep + 1);
  if (!safeEqual(password, env.ADMIN_PASSWORD)) {
    unauthorized(reply);
    return;
  }
}
