import { useCallback, useEffect, useRef, useState } from "react";

export type TtsPlayerStatus = "idle" | "playing" | "cancelled" | "error";

export type UseTTSPlayerOptions = {
  onDone?: () => void;
  onCancel?: () => void;
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
  const { onDone, onCancel, sampleRate = DEFAULT_SAMPLE_RATE } = options;

  const [status, setStatus] = useState<TtsPlayerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const cancelledRef = useRef(false);
  const isDoneSignaledRef = useRef(false);
  const onDoneRef = useRef(onDone);
  const onCancelRef = useRef(onCancel);
  onDoneRef.current = onDone;
  onCancelRef.current = onCancel;

  const ensureContext = useCallback(async (): Promise<AudioContext> => {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      ctxRef.current = new AudioContext({ sampleRate });
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
    setStatus("idle");
    onDoneRef.current?.();
  }, []);

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
        source.connect(ctx.destination);

        const now = ctx.currentTime;
        const startAt = Math.max(now, nextStartTimeRef.current);
        source.start(startAt);
        nextStartTimeRef.current = startAt + audioBuffer.duration;

        activeSourcesRef.current.push(source);
        setStatus("playing");
        setError(null);

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
    [ensureContext, sampleRate, maybeFinish],
  );

  const markDone = useCallback((): void => {
    isDoneSignaledRef.current = true;
    maybeFinish();
  }, [maybeFinish]);

  const cancel = useCallback((): void => {
    cancelledRef.current = true;
    isDoneSignaledRef.current = false;

    for (const source of activeSourcesRef.current) {
      try {
        source.stop();
        source.disconnect();
      } catch {}
    }
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;

    setStatus("cancelled");
    onCancelRef.current?.();
  }, []);

  const prepare = useCallback((): void => {
    cancelledRef.current = false;
    isDoneSignaledRef.current = false;
    nextStartTimeRef.current = 0;
    setError(null);
    setStatus("idle");
  }, []);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      for (const source of activeSourcesRef.current) {
        try {
          source.stop();
          source.disconnect();
        } catch {}
      }
      activeSourcesRef.current = [];
      if (ctxRef.current && ctxRef.current.state !== "closed") {
        void ctxRef.current.close();
      }
      ctxRef.current = null;
    };
  }, []);

  return {
    status,
    error,
    isPlaying: status === "playing",
    enqueue,
    markDone,
    cancel,
    prepare,
  };
}
