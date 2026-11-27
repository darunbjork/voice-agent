import type { WarmupStatus } from "../../hooks/useServerWarmup.js";

export type ServerStatusChipProps = {
  status: WarmupStatus;
  elapsedS: number;
  onRetry: () => void;
  /**
   * "header": the page-level live region. "inline": the same state next to
   * the mic and input (C10b), not a second live region, so screen readers
   * hear it once.
   */
  variant?: "header" | "inline";
};

/** C10: tells visitors a cold start is normal, not a broken app. */
export function ServerStatusChip({
  status,
  elapsedS,
  onRetry,
  variant = "header",
}: ServerStatusChipProps) {
  const inline = variant === "inline";
  return (
    <div
      data-testid={inline ? "server-status-inline" : "server-status"}
      className={`server-chip server-chip--${status}${inline ? " server-chip--inline" : ""}`}
      {...(inline ? {} : { role: "status", "aria-live": "polite" as const })}
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
