import { connect } from "node:net";

const DEFAULT_PORTS: Record<string, number> = {
  "postgresql:": 5432,
  "postgres:": 5432,
  "redis:": 6379,
  "rediss:": 6379,
};

/** Host and port of a connection URL (default port per scheme). */
export function endpointOf(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: u.port ? Number(u.port) : (DEFAULT_PORTS[u.protocol] ?? 0) };
}

function reachable(
  { host, port }: { host: string; port: number },
  timeoutMs = 1500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Throws one readable error when a service the API tests need is down, so a
 * run never reports dozens of unrelated Prisma failures (or a cached pass).
 */
export async function assertServicesReachable(env: {
  DATABASE_URL: string;
  REDIS_URL?: string | undefined;
}): Promise<void> {
  const hint =
    "Start them with `docker compose up -d` (Postgres :5434, Redis :6380) and run " +
    "`pnpm --filter @voice-agent/api exec prisma migrate deploy` once.";
  const pg = endpointOf(env.DATABASE_URL);
  if (!(await reachable(pg))) {
    throw new Error(`Postgres is not reachable at ${pg.host}:${pg.port} (DATABASE_URL). ${hint}`);
  }
  if (env.REDIS_URL) {
    const redis = endpointOf(env.REDIS_URL);
    if (!(await reachable(redis))) {
      throw new Error(`Redis is not reachable at ${redis.host}:${redis.port} (REDIS_URL). ${hint}`);
    }
  }
}
