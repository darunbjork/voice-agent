export class AgentTurnAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTurnAbortedError";
  }
}

export function isTurnAborted(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (err instanceof AgentTurnAbortedError) return true;
  return err instanceof Error && err.name === "AbortError";
}

export function assertNotAborted(signal: AbortSignal | undefined, reason: string): void {
  if (signal?.aborted) {
    throw new AgentTurnAbortedError(reason);
  }
}
