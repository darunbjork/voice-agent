import { useCallback, useRef, useState } from "react";

export type VADState = "silence" | "speech";

export type UseVADOptions = {
  threshold?: number;
  minSpeechMs?: number;
  silenceDurationMs?: number;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
};

export type UseVADControls = {
  feed: (rms: number) => void;
  reset: () => void;
};

const DEFAULT_THRESHOLD = 0.02;
const DEFAULT_MIN_SPEECH_MS = 150;
const DEFAULT_SILENCE_MS = 500;

export function useVAD(options: UseVADOptions = {}): { state: VADState } & UseVADControls {
  const {
    threshold = DEFAULT_THRESHOLD,
    minSpeechMs = DEFAULT_MIN_SPEECH_MS,
    silenceDurationMs = DEFAULT_SILENCE_MS,
    onSpeechStart,
    onSpeechEnd,
  } = options;

  const [state, setState] = useState<VADState>("silence");

  const stateRef = useRef<VADState>("silence");
  const aboveSinceRef = useRef<number | null>(null);
  const belowSinceRef = useRef<number | null>(null);
  const onSpeechStartRef = useRef(onSpeechStart);
  const onSpeechEndRef = useRef(onSpeechEnd);
  onSpeechStartRef.current = onSpeechStart;
  onSpeechEndRef.current = onSpeechEnd;

  const reset = useCallback(() => {
    stateRef.current = "silence";
    aboveSinceRef.current = null;
    belowSinceRef.current = null;
    setState("silence");
  }, []);

  const feed = useCallback(
    (rms: number) => {
      const now = performance.now();
      const above = rms >= threshold;

      if (stateRef.current === "silence") {
        if (above) {
          if (aboveSinceRef.current === null) {
            aboveSinceRef.current = now;
          } else if (now - aboveSinceRef.current >= minSpeechMs) {
            stateRef.current = "speech";
            belowSinceRef.current = null;
            setState("speech");
            onSpeechStartRef.current?.();
          }
        } else {
          aboveSinceRef.current = null;
        }
        return;
      }

      if (!above) {
        if (belowSinceRef.current === null) {
          belowSinceRef.current = now;
        } else if (now - belowSinceRef.current >= silenceDurationMs) {
          stateRef.current = "silence";
          aboveSinceRef.current = null;
          setState("silence");
          onSpeechEndRef.current?.();
        }
      } else {
        belowSinceRef.current = null;
      }
    },
    [threshold, minSpeechMs, silenceDurationMs],
  );

  return { state, feed, reset };
}
