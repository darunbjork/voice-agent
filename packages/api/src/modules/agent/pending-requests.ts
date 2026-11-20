// Unfinished requests waiting for the user's next turn, per session.
// "What does good night mean?" → "Which language…?" → "French" completes it.

/** Slots of a translation the user has not finished (original / toLang / fromLang). */
export type PendingTranslation = Record<string, string>;

/** A pending question expires if the user does not answer soon. */
export const PENDING_TTL_MS = 2 * 60_000;

const store = new Map<string, { slots: PendingTranslation; expiresAt: number }>();

export function setPendingTranslation(sessionId: string, slots: PendingTranslation): void {
  store.set(sessionId, { slots, expiresAt: Date.now() + PENDING_TTL_MS });
}

/** Returns and removes the session's pending translation (if still fresh). */
export function takePendingTranslation(sessionId: string): PendingTranslation | null {
  const entry = store.get(sessionId);
  store.delete(sessionId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.slots;
}

export function resetPendingRequests(): void {
  store.clear();
}
