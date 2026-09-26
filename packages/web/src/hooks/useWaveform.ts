import { useCallback, useRef } from "react";

export type UseWaveformResult = {
  bufferRef: React.RefObject<number[]>;
  feed: (rms: number) => void;
  reset: () => void;
};

export function useWaveform(historySize = 64): UseWaveformResult {
  const bufferRef = useRef<number[]>([]);

  const feed = useCallback(
    (rms: number) => {
      const buf = bufferRef.current;
      buf.push(rms);
      if (buf.length > historySize) {
        buf.shift();
      }
    },
    [historySize],
  );

  const reset = useCallback(() => {
    bufferRef.current = [];
  }, []);

  return { bufferRef, feed, reset };
}
