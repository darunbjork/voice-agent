import { SHARED_TYPES_VERSION, type HealthStatus } from "@voice-agent/shared-types";

const status: HealthStatus = "ok";

console.log(`[api] shared-types version: ${SHARED_TYPES_VERSION}`);
console.log(`[api] health status: ${status}`);
console.log("[api] Day 1 scaffold ready. Waiting for Day 3 Fastify bootstrap.");