// C10 — Fly scales the API and Postgres to zero; the first request after idle
// took 25.7 s, so the page looked broken. On load we send one GET /health
// (no-store): it wakes the API and runs SELECT 1, which wakes the DB. /health
// reads counters only, so warming up uses no LLM/TTS/STT budget. A request
// that fails is retried with backoff (1 s → 8 s); one that hangs is left open,
// because that open request is what wakes the machine. After 60 s: "failed".
import { useCallback, useEffect, useState } from "react";

export type WarmupStatus = "waking" | "ready" | "failed";

export const WARMUP_DEADLINE_MS = 60_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 8_000;

function healthUrl(): string {
  return `${import.meta.env.VITE_API_URL ?? ""}/health`;
}

/** Ready when the API answers 2xx and its DB is not down. */
async function isHealthy(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  try {
    const body = (await res.json()) as { status?: string };
    return body.status !== "down";
  } catch {
    return false;
  }
}

export function useServerWarmup(deadlineMs: number = WARMUP_DEADLINE_MS) {
  const [status, setStatus] = useState<WarmupStatus>("waking");
  const [elapsedS, setElapsedS] = useState(0);
  /** Bumped by retry(): restarts the warm-up. */
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    let done = false;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setStatus("waking");
    setElapsedS(0);

    const finish = (next: WarmupStatus) => {
      if (done) return;
      done = true;
      clearInterval(ticker);
      clearTimeout(deadline);
      clearTimeout(retryTimer);
      setStatus(next);
    };

    // The counter is local only: it sends nothing.
    const ticker = setInterval(() => setElapsedS((s) => s + 1), 1_000);
    const deadline = setTimeout(() => {
      controller.abort();
      finish("failed");
    }, deadlineMs);

    const attempt = (nextDelay: number) => {
      fetch(healthUrl(), { cache: "no-store", signal: controller.signal })
        .then(isHealthy)
        .catch(() => false)
        .then((healthy) => {
          if (done) return;
          if (healthy) {
            finish("ready");
            return;
          }
          retryTimer = setTimeout(() => attempt(Math.min(nextDelay * 2, MAX_RETRY_MS)), nextDelay);
        });
    };
    attempt(FIRST_RETRY_MS);

    return () => {
      done = true;
      clearInterval(ticker);
      clearTimeout(deadline);
      clearTimeout(retryTimer);
      controller.abort();
    };
  }, [cycle, deadlineMs]);

  const retry = useCallback(() => setCycle((c) => c + 1), []);

  return { status, elapsedS, retry };
}
