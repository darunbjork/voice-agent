import type { FastifyRequest } from "fastify";
import { env } from "../env.js";

/**
 * The address rate limits are keyed on.
 *
 * X-Forwarded-For is not trusted (trustProxy is off): its left-most entry is
 * whatever the client sent, so a new value per request reset every limit.
 * On Fly.io the edge proxy sets Fly-Client-IP to the address it received the
 * request from, overwriting any client-sent value; FLY_APP_NAME is set by the
 * Fly runtime. Anywhere else the header is client-controlled and ignored, and
 * the socket address is used.
 */
export function clientIp(request: FastifyRequest): string {
  if (env.FLY_APP_NAME) {
    const fly = request.headers["fly-client-ip"];
    if (typeof fly === "string" && fly.length > 0) return fly;
  }
  return request.ip;
}
