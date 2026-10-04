import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeRms } from "../lib/audio-utils.js";
import { computePlaybackProgress } from "../lib/playback.js";
import { prefersReducedMotion } from "../lib/motion.js";

export type TtsPlayerStatus = "idle" | "playing" | "cancelled" | "error";

export type UseTTSPlayerOptions = {
  onDone?: () => void;
  onCancel?: () => void;
  onLevel?: (rms: number) => void;
  sampleRate?: number;
};

const DEFAULT_SAMPLE_RATE = 16_000;

function pcm16ToAudioBuffer(ctx: AudioContext, pcm: ArrayBuffer, sampleRate: number): AudioBuffer {
  const int16 = new Int16Array(pcm);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = (int16[i] ?? 0) / 32768;
  }
  const buffer = ctx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);
  return buffer;
}

export function useTTSPlayer(options: UseTTSPlayerOptions = {}) {
  const { onDone, onCancel, onLevel, sampleRate = DEFAULT_SAMPLE_RATE } = options;

  const [status, setStatus] = useState<TtsPlayerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const sessionStartRef = useRef<number | null>(null);
  const sessionEndRef = useRef<number | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const cancelledRef = useRef(false);
  const isDoneSignaledRef = useRef(false);
  const onDoneRef = useRef(onDone);
  const onCancelRef = useRef(onCancel);
  const onLevelRef = useRef(onLevel);
  onDoneRef.current = onDone;
  onCancelRef.current = onCancel;
  onLevelRef.current = onLevel;

  const stopLevelLoop = useCallback((): void => {
    if (levelRafRef.current !== null) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }
  }, []);

  const startLevelLoop = useCallback((): void => {
    if (levelRafRef.current !== null) return;
    if (prefersReducedMotion()) return;
    if (!analyserRef.current) return;

    const buffer = new Float32Array(analyserRef.current.fftSize);

    const tick = (): void => {
      const analyser = analyserRef.current;
      if (analyser) {
        analyser.getFloatTimeDomainData(buffer);
        onLevelRef.current?.(computeRms(buffer));
      }
      levelRafRef.current = requestAnimationFrame(tick);
    };

    levelRafRef.current = requestAnimationFrame(tick);
  }, []);

  const ensureContext = useCallback(async (): Promise<AudioContext> => {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      const ctx = new AudioContext({ sampleRate });
      const analyser = ctx.createAnalyser();
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      ctxRef.current = ctx;
    }
    if (ctxRef.current.state === "suspended") {
      await ctxRef.current.resume();
    }
    return ctxRef.current;
  }, [sampleRate]);

  const maybeFinish = useCallback((): void => {
    if (!isDoneSignaledRef.current) return;
    if (cancelledRef.current) return;
    if (activeSourcesRef.current.length > 0) return;

    isDoneSignaledRef.current = false;
    stopLevelLoop();
    setStatus("idle");
    onDoneRef.current?.();
  }, [stopLevelLoop]);

  const enqueue = useCallback(
    async (pcm: ArrayBuffer, _sequenceNum: number): Promise<void> => {
      if (cancelledRef.current) return;
      if (pcm.byteLength === 0) return;

      try {
        const ctx = await ensureContext();

        if (cancelledRef.current) return;

        const audioBuffer = pcm16ToAudioBuffer(ctx, pcm, sampleRate);
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(analyserRef.current ?? ctx.destination);

        const now = ctx.currentTime;
        const startAt = Math.max(now, nextStartTimeRef.current);
        source.start(startAt);
        nextStartTimeRef.current = startAt + audioBuffer.duration;

        if (sessionStartRef.current === null) {
          sessionStartRef.current = startAt;
        }
        sessionEndRef.current = nextStartTimeRef.current;

        activeSourcesRef.current.push(source);
        setStatus("playing");
        setError(null);
        startLevelLoop();

        source.onended = () => {
          activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
          maybeFinish();
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "TTS playback failed";
        setError(message);
        setStatus("error");
      }
    },
    [ensureContext, sampleRate, maybeFinish, startLevelLoop],
  );

  const markDone = useCallback((): void => {
    isDoneSignaledRef.current = true;
    maybeFinish();
  }, [maybeFinish]);

  const cancel = useCallback((): void => {
    cancelledRef.current = true;
    isDoneSignaledRef.current = false;
    stopLevelLoop();

    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // an already-stopped source throws; nothing to clean up
      }
    }
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;
    sessionStartRef.current = null;
    sessionEndRef.current = null;

    setStatus("cancelled");
    onCancelRef.current?.();
  }, [stopLevelLoop]);

  const prepare = useCallback((): void => {
    cancelledRef.current = false;
    isDoneSignaledRef.current = false;
    nextStartTimeRef.current = 0;
    sessionStartRef.current = null;
    sessionEndRef.current = null;
    setError(null);
    setStatus("idle");
  }, []);

  const getProgress = useCallback((): number => {
    const ctx = ctxRef.current;
    if (!ctx) return 0;
    return computePlaybackProgress(sessionStartRef.current, sessionEndRef.current, ctx.currentTime);
  }, []);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      stopLevelLoop();
      for (const source of activeSourcesRef.current) {
        try {
          source.stop();
          source.disconnect();
        } catch {
          // an already-stopped source throws; nothing to clean up
        }
      }
      activeSourcesRef.current = [];
      analyserRef.current?.disconnect();
      analyserRef.current = null;
      if (ctxRef.current && ctxRef.current.state !== "closed") {
        void ctxRef.current.close();
      }
      ctxRef.current = null;
    };
  }, [stopLevelLoop]);

  return useMemo(
    () => ({
      status,
      error,
      isPlaying: status === "playing",
      enqueue,
      markDone,
      cancel,
      prepare,
      getProgress,
    }),
    [status, error, enqueue, markDone, cancel, prepare, getProgress],
  );
}
