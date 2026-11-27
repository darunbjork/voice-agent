import type { WarmupStatus } from "../../hooks/useServerWarmup.js";

export type ServerStatusChipProps = {
  status: WarmupStatus;
  elapsedS: number;
  onRetry: () => void;
};

/** C10: tells visitors a cold start is normal, not a broken app. */
export function ServerStatusChip({ status, elapsedS, onRetry }: ServerStatusChipProps) {
  return (
    <div
      data-testid="server-status"
      className={`server-chip server-chip--${status}`}
      role="status"
      aria-live="polite"
    >
      {status === "waking" && (
        <>
          <span className="server-chip__dot" aria-hidden="true" />
          Waking up the server… <span aria-hidden="true">{elapsedS}s</span> (free hosting, can take
          ~30 s)
        </>
      )}
      {status === "ready" && (
        <>
          <span className="server-chip__dot" aria-hidden="true" />
          Ready
        </>
      )}
      {status === "failed" && (
        <>
          Server didn&apos;t wake up —{" "}
          <button type="button" className="banner__action" onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </div>
  );
}
