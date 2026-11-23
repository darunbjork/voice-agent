// Vitest globalSetup: runs once before the API suite and stops it with one
// clear message when Postgres (or Redis, if REDIS_URL is set) is down.
import { config } from "dotenv";
import { assertServicesReachable } from "./require-services.js";

export default async function setup(): Promise<void> {
  // Same files, same order as src/env.ts (cwd is packages/api).
  config({ path: ["../../.env", ".env"] });
  await assertServicesReachable({
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    REDIS_URL: process.env.REDIS_URL || undefined,
  });
}
