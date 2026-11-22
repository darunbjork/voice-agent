// Unfinished requests waiting for the user's next turn, per session.
// "What does good night mean?" → "Which language…?" → "French" completes it.
// "Weather in the Middle East?" → "Which city…?" → "Paris" completes it.

/** Slots of a translation the user has not finished (original / toLang / fromLang). */
export type PendingTranslation = Record<string, string>;

/** A weather request that is waiting for a city; `request` is the original wording. */
export type PendingWeather = { request: string };

/** A pending question expires if the user does not answer soon. */
export const PENDING_TTL_MS = 2 * 60_000;

type Entry<T> = { value: T; expiresAt: number };

const translations = new Map<string, Entry<PendingTranslation>>();
const weather = new Map<string, Entry<PendingWeather>>();

function take<T>(store: Map<string, Entry<T>>, sessionId: string): T | null {
  const entry = store.get(sessionId);
  store.delete(sessionId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.value;
}

export function setPendingTranslation(sessionId: string, slots: PendingTranslation): void {
  translations.set(sessionId, { value: slots, expiresAt: Date.now() + PENDING_TTL_MS });
}

/** Returns and removes the session's pending translation (if still fresh). */
export function takePendingTranslation(sessionId: string): PendingTranslation | null {
  return take(translations, sessionId);
}

export function setPendingWeather(sessionId: string, pending: PendingWeather): void {
  weather.set(sessionId, { value: pending, expiresAt: Date.now() + PENDING_TTL_MS });
}

/** Returns and removes the session's pending weather request (if still fresh). */
export function takePendingWeather(sessionId: string): PendingWeather | null {
  return take(weather, sessionId);
}

export function resetPendingRequests(): void {
  translations.clear();
  weather.clear();
}
