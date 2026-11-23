// The API suite needs Postgres (and Redis when REDIS_URL is set). Without
// them, 8 test files used to fail with Prisma connection errors while a cached
// `pnpm test` still reported "399 passed". The global setup now stops the run
// with one clear message instead.
import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { assertServicesReachable, endpointOf } from "./support/require-services.js";

/** A localhost port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("test service check", () => {
  it("parses host and port from connection URLs", () => {
    expect(endpointOf("postgresql://u:p@localhost:5434/db")).toEqual({
      host: "localhost",
      port: 5434,
    });
    expect(endpointOf("redis://127.0.0.1:6380")).toEqual({ host: "127.0.0.1", port: 6380 });
    expect(endpointOf("postgresql://u:p@db/x")).toEqual({ host: "db", port: 5432 });
    expect(endpointOf("redis://cache")).toEqual({ host: "cache", port: 6379 });
  });

  it("fails with a clear message when Postgres is not reachable", async () => {
    const port = await closedPort();
    await expect(
      assertServicesReachable({ DATABASE_URL: `postgresql://u:p@127.0.0.1:${port}/db` }),
    ).rejects.toThrow(/Postgres is not reachable at 127\.0\.0\.1:\d+.*docker compose up -d/s);
  });

  it("fails with a clear message when REDIS_URL is set but Redis is not reachable", async () => {
    const port = await closedPort();
    await expect(
      assertServicesReachable({
        DATABASE_URL: process.env.DATABASE_URL ?? "",
        REDIS_URL: `redis://127.0.0.1:${port}`,
      }),
    ).rejects.toThrow(/Redis is not reachable/);
  });

  it("passes when the configured services are up", async () => {
    await expect(
      assertServicesReachable({
        DATABASE_URL: process.env.DATABASE_URL ?? "",
        REDIS_URL: process.env.REDIS_URL,
      }),
    ).resolves.toBeUndefined();
  });
});
