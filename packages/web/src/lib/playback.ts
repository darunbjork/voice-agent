export function computePlaybackProgress(
  start: number | null,
  end: number | null,
  now: number,
): number {
  if (start === null || end === null || end <= start) return 0;
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}
