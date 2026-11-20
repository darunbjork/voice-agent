/**
 * Keeps a stream of 16-bit PCM byte chunks sample-aligned.
 *
 * Defensive copy of the server-side aligner (packages/api/src/utils/pcm-align.ts).
 * HTTP streaming (ElevenLabs, Deepgram Aura) delivers audio in arbitrary
 * network-sized reads, so a chunk can end halfway through a 2-byte sample.
 * Forwarded as-is, the browser cannot build an Int16Array from an odd-length
 * chunk and every later sample is read one byte off (byte-swapped), which is
 * heard as harsh buzzing. This carries the odd trailing byte into the next
 * chunk so every emitted chunk has an even length.
 */
export class Pcm16Aligner {
  private carry: number | null = null;
  /** Input chunks that ended mid-sample (telemetry). */
  oddChunks = 0;

  /** Returns an even-length copy of the aligned bytes, or null if none are ready yet. */
  push(bytes: Uint8Array): ArrayBuffer | null {
    const total = bytes.byteLength + (this.carry === null ? 0 : 1);
    if (bytes.byteLength % 2 === 1) this.oddChunks += 1;
    const even = total - (total % 2);
    if (even === 0) {
      if (bytes.byteLength > 0) this.carry = bytes[bytes.byteLength - 1] ?? null;
      return null;
    }

    const out = new Uint8Array(even);
    let offset = 0;
    if (this.carry !== null) {
      out[0] = this.carry;
      offset = 1;
    }
    out.set(bytes.subarray(0, even - offset), offset);
    this.carry = total % 2 === 1 ? (bytes[bytes.byteLength - 1] ?? null) : null;
    return out.buffer;
  }

  /** Drop any half sample (end of stream or provider switch). */
  reset(): void {
    this.carry = null;
  }
}
