import { useCallback, useEffect, useRef, useState } from "react";

export type BargeInStatus = "idle" | "armed" | "triggered" | "cooldown";

export type UseBargeInOptions = {
  isTtsPlaying: boolean;
  isUserSpeaking: boolean;
  cancelTts: () => void;
  sendBargeIn: () => void;
  minSpeechMs?: number;
  cooldownMs?: number;
  onBargeIn?: (localWorkMs: number) => void;
};

const DEFAULT_MIN_SPEECH_MS = 0;
const DEFAULT_COOLDOWN_MS = 400;

export function useBargeIn(options: UseBargeInOptions) {
  const {
    isTtsPlaying,
    isUserSpeaking,
    cancelTts,
    sendBargeIn,
    minSpeechMs = DEFAULT_MIN_SPEECH_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    onBargeIn,
  } = options;

  const [status, setStatus] = useState<BargeInStatus>("idle");
  const [lastLocalWorkMs, setLastLocalWorkMs] = useState<number | null>(null);

  const speechStartedAtRef = useRef<number | null>(null);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBargeInRef = useRef(onBargeIn);
  onBargeInRef.current = onBargeIn;

  const clearCooldownTimer = useCallback(() => {
    if (cooldownTimerRef.current !== null) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (status === "cooldown" || status === "triggered") return;

    if (isTtsPlaying && status === "idle") {
      setStatus("armed");
      speechStartedAtRef.current = null;
    } else if (!isTtsPlaying && status === "armed") {
      setStatus("idle");
      speechStartedAtRef.current = null;
    }
  }, [isTtsPlaying, status]);

  useEffect(() => {
    if (status !== "armed") return;

    if (isUserSpeaking) {
      if (speechStartedAtRef.current === null) {
        speechStartedAtRef.current = performance.now();
      }

      const spokenFor = performance.now() - (speechStartedAtRef.current ?? performance.now());

      if (spokenFor >= minSpeechMs) {
        const t0 = performance.now();
        cancelTts();
        sendBargeIn();
        const localWorkMs = performance.now() - t0;

        setLastLocalWorkMs(localWorkMs);
        setStatus("triggered");
        onBargeInRef.current?.(localWorkMs);

        clearCooldownTimer();
        cooldownTimerRef.current = setTimeout(() => {
          speechStartedAtRef.current = null;
          setStatus("idle");
          cooldownTimerRef.current = null;
        }, cooldownMs);
      }
    } else {
      speechStartedAtRef.current = null;
    }
  }, [isUserSpeaking, status, minSpeechMs, cancelTts, sendBargeIn, cooldownMs, clearCooldownTimer]);

  useEffect(() => {
    return () => {
      clearCooldownTimer();
    };
  }, [clearCooldownTimer]);

  return {
    status,
    lastLocalWorkMs,
    isArmed: status === "armed",
    isTriggered: status === "triggered",
  };
}
