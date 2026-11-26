// Waits for Postgres before `prisma migrate deploy` (called by scripts/release.sh).
// Fly's Postgres machine sleeps when idle: it wakes on the first connection but
// takes more than 5 s, so the release_command failed with Prisma P1001.
// Here: SELECT 1, retried with doubling backoff (1 s → 8 s cap) for up to 60 s.
import { pathToFileURL } from "node:url";
import { PrismaClient } from "../generated/prisma/index.js";

export class DbNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbNotReadyError";
  }
}

export type WaitForDbOptions = {
  /** Resolves when the database answers; throws otherwise. */
  check: () => Promise<void>;
  log: (message: string) => void;
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests (fake clock); real time by default. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * One line for the log. Prisma's message starts with "Invalid `prisma.$queryRaw()`
 * invocation:" and ends with the real cause ("Can't reach database server at …"),
 * so the last line is used, prefixed with the Prisma code (P1001) when there is one.
 */
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const last =
    message
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "error";
  // PrismaClientKnownRequestError has `code`; PrismaClientInitializationError has `errorCode`.
  const e = err as { code?: unknown; errorCode?: unknown } | null;
  const code = e?.code ?? e?.errorCode;
  return typeof code === "string" && !last.includes(code) ? `${code}: ${last}` : last;
}

export async function waitForDb(options: WaitForDbOptions): Promise<{ attempts: number }> {
  const {
    check,
    log,
    timeoutMs = 60_000,
    initialDelayMs = 1_000,
    maxDelayMs = 8_000,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = options;

  const deadline = now() + timeoutMs;
  let delay = initialDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await check();
      log(`[release] DB check attempt ${attempt}: ready`);
      return { attempts: attempt };
    } catch (err) {
      const cause = errorText(err);
      const remaining = deadline - now();
      if (remaining <= 0) {
        log(`[release] DB check attempt ${attempt}: not reachable (${cause}); giving up`);
        throw new DbNotReadyError(
          `Database not reachable after ${attempt} attempts in ${Math.round(timeoutMs / 1000)} s: ${cause}`,
        );
      }
      const wait = Math.min(delay, maxDelayMs, remaining);
      log(
        `[release] DB check attempt ${attempt}: not reachable (${cause}); retrying in ${wait} ms`,
      );
      await sleep(wait);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

/** SELECT 1 on a fresh connection; rejects on error or after `timeoutMs`. */
export async function selectOne(url: string, timeoutMs: number): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url } }, log: [] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`attempt timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[release] DATABASE_URL is not set");
    process.exit(1);
  }
  try {
    await waitForDb({ check: () => selectOne(url, 10_000), log: (m) => console.log(m) });
  } catch (err) {
    console.error(`[release] ${errorText(err)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
