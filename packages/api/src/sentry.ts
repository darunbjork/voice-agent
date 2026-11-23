import * as Sentry from "@sentry/node";

import { env } from "./env.js";

export function initSentry(): void {
  if (!env.SENTRY_DSN) return;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0,
    integrations: [
      // Errors are reported explicitly by captureServerError (HTTP 500s and
      // failed WebSocket turns), so the integration's own capture is off and
      // each error reaches Sentry once. (setupFastifyErrorHandler is a
      // deprecated no-op in @sentry/node 11.)
      Sentry.fastifyIntegration({ shouldHandleError: () => false }),
    ],
  });
}

/** Reports a server-side error to Sentry when SENTRY_DSN is set. Never throws. */
export function captureServerError(err: unknown, tags: Record<string, string>): void {
  if (!env.SENTRY_DSN) return;
  try {
    Sentry.captureException(err, { tags });
  } catch {
    // Reporting must never break the request that failed.
  }
}
