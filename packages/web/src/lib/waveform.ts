export const MIN_BAR_HEIGHT = 2;
export const STATIC_BAR_HEIGHT = 4;

export function computeBarHeights(
  samples: readonly number[],
  barCount: number,
  height: number,
  reduced: boolean,
): number[] {
  const staticHeight = Math.min(height, STATIC_BAR_HEIGHT);

  if (reduced || samples.length === 0) {
    return new Array<number>(barCount).fill(staticHeight);
  }

  const heights: number[] = [];
  for (const sample of samples.slice(0, barCount)) {
    heights.push(Math.max(MIN_BAR_HEIGHT, Math.min(height, sample * height * 1.8)));
  }
  return heights;
}
