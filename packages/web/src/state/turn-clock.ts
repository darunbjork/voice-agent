/**
 * Times one turn for the HUD: end of speech → first TTS audio byte.
 * The server reports how long ago speech ended when it sent transcript_final
 * (sinceSpeechEndMs), so the anchor is local time minus that — no clock sync
 * between server and browser is needed.
 */
export function createTurnClock(now: () => number = () => performance.now()) {
  let speechEndedAt: number | null = null;

  return {
    /** A transcript_final arrived. Typed input has no speech-end time. */
    finalReceived(sinceSpeechEndMs: number | undefined): void {
      speechEndedAt = now() - Math.max(0, sinceSpeechEndMs ?? 0);
    },
    /** First TTS audio byte of the turn: its TOTAL in ms, then null until the next final. */
    firstAudio(): number | null {
      if (speechEndedAt === null) return null;
      const total = Math.round(now() - speechEndedAt);
      speechEndedAt = null;
      return total;
    },
  };
}
