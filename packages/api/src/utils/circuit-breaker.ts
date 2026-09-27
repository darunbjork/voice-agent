export type ProviderName = "gemini" | "deepgram" | "elevenlabs";

export type CircuitState = "closed" | "open" | "half_open";

export type CircuitSnapshot = {
  provider: ProviderName;
  state: CircuitState;
  failures: number;
  openedAt: number | null;
  lastFailureAt: number | null;
};

export class CircuitOpenError extends Error {
  constructor(
    public readonly provider: ProviderName,
    message?: string,
  ) {
    super(message ?? `Circuit open for provider: ${provider}`);
    this.name = "CircuitOpenError";
  }
}

type BreakerConfig = {
  failureThreshold: number;
  openDurationMs: number;
  probeTimeoutMs: number;
};

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  openDurationMs: 30_000,
  probeTimeoutMs: 30_000,
};

type InternalState = {
  failures: number;
  state: CircuitState;
  openedAt: number | null;
  lastFailureAt: number | null;
  probeInFlight: boolean;
  probeStartedAt: number | null;
};

const store = new Map<ProviderName, InternalState>();

function getState(provider: ProviderName): InternalState {
  let s = store.get(provider);
  if (!s) {
    s = {
      failures: 0,
      state: "closed",
      openedAt: null,
      lastFailureAt: null,
      probeInFlight: false,
      probeStartedAt: null,
    };
    store.set(provider, s);
  }
  return s;
}

export function assertCircuitClosed(provider: ProviderName): void {
  const s = getState(provider);
  const now = Date.now();

  if (s.state === "closed") return;

  if (s.state === "half_open") {
    // A probe that never reported back (parse error, client cancel) would
    // otherwise wedge the provider forever — hand the slot over after
    // probeTimeoutMs.
    const probeExpired =
      s.probeStartedAt !== null && now - s.probeStartedAt >= DEFAULT_CONFIG.probeTimeoutMs;
    if (s.probeInFlight && !probeExpired) throw new CircuitOpenError(provider);
    s.probeInFlight = true;
    s.probeStartedAt = now;
    return;
  }

  if (s.openedAt !== null && now - s.openedAt >= DEFAULT_CONFIG.openDurationMs) {
    s.state = "half_open";
    s.probeInFlight = true;
    s.probeStartedAt = now;
    return;
  }

  throw new CircuitOpenError(provider);
}

export function recordSuccess(provider: ProviderName): void {
  const s = getState(provider);
  s.failures = 0;
  s.state = "closed";
  s.openedAt = null;
  s.lastFailureAt = null;
  s.probeInFlight = false;
  s.probeStartedAt = null;
}

export function recordFailure(provider: ProviderName): void {
  const s = getState(provider);
  s.failures += 1;
  s.lastFailureAt = Date.now();
  s.probeInFlight = false;
  s.probeStartedAt = null;

  if (s.state === "half_open") {
    s.state = "open";
    s.openedAt = Date.now();
    return;
  }

  if (s.failures >= DEFAULT_CONFIG.failureThreshold) {
    s.state = "open";
    s.openedAt = Date.now();
  }
}

export function getCircuitSnapshot(provider: ProviderName): CircuitSnapshot {
  const s = getState(provider);
  return {
    provider,
    state: s.state,
    failures: s.failures,
    openedAt: s.openedAt,
    lastFailureAt: s.lastFailureAt,
  };
}

export function getAllCircuitSnapshots(): CircuitSnapshot[] {
  return (["gemini", "deepgram", "elevenlabs"] as ProviderName[]).map(getCircuitSnapshot);
}

export function resetAllCircuits(): void {
  store.clear();
}
