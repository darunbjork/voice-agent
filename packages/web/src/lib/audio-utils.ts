export const TARGET_SAMPLE_RATE = 16_000;
export const TARGET_CHANNELS = 1;
export const TARGET_BIT_DEPTH = 16;
export const MAX_PCM_CHUNK_BYTES = 4096;

export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const sample = float32[i] ?? 0;
    const s = Math.max(-1, Math.min(1, sample));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

export function computeRms(float32: Float32Array): number {
  if (float32.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) {
    const s = float32[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / float32.length);
}

export function clampChunk(buffer: ArrayBuffer): {
  chunk: ArrayBuffer;
  truncated: boolean;
} {
  if (buffer.byteLength <= MAX_PCM_CHUNK_BYTES) {
    return { chunk: buffer, truncated: false };
  }
  return {
    chunk: buffer.slice(0, MAX_PCM_CHUNK_BYTES),
    truncated: true,
  };
}
