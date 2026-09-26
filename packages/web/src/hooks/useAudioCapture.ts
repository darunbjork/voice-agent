import { useCallback, useEffect, useRef, useState } from "react";
import {
  TARGET_SAMPLE_RATE,
  float32ToInt16,
  computeRms,
  clampChunk,
  MAX_PCM_CHUNK_BYTES,
} from "../lib/audio-utils.js";

export type CaptureStatus = "idle" | "requesting_permission" | "capturing" | "error";

export type AudioCaptureState = {
  status: CaptureStatus;
  error: string | null;
  level: number;
  isCapturing: boolean;
};

export type AudioCaptureControls = {
  start: () => Promise<void>;
  stop: () => void;
};

export type UseAudioCaptureOptions = {
  onChunk: (chunk: ArrayBuffer) => void;
};

export function useAudioCapture(
  options: UseAudioCaptureOptions,
): AudioCaptureState & AudioCaptureControls {
  const { onChunk } = options;

  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  const stop = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close();
    }
    audioContextRef.current = null;

    setStatus("idle");
    setLevel(0);
  }, []);

  const start = useCallback(async () => {
    if (status === "capturing" || status === "requesting_permission") return;

    setStatus("requesting_permission");
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      mediaStreamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      audioContextRef.current = ctx;

      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const bufferSize = 2048;
      const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      const inputSampleRate = ctx.sampleRate;
      const ratio = inputSampleRate / TARGET_SAMPLE_RATE;

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        const input = event.inputBuffer.getChannelData(0);
        const rms = computeRms(input);
        setLevel(rms);

        let samples: Float32Array;
        if (Math.abs(ratio - 1) < 0.01) {
          samples = input;
        } else {
          const newLength = Math.floor(input.length / ratio);
          samples = new Float32Array(newLength);
          for (let i = 0; i < newLength; i++) {
            const srcIndex = i * ratio;
            const idx = Math.floor(srcIndex);
            const frac = srcIndex - idx;
            const a = input[idx] ?? 0;
            const b = input[idx + 1] ?? a;
            samples[i] = a + (b - a) * frac;
          }
        }

        const int16 = float32ToInt16(samples);
        const arrayBuffer = new ArrayBuffer(int16.byteLength);
        new Uint8Array(arrayBuffer).set(int16);
        const { chunk, truncated } = clampChunk(arrayBuffer);

        if (truncated) {
          console.warn(`[useAudioCapture] chunk truncated to ${MAX_PCM_CHUNK_BYTES} bytes`);
        }

        onChunkRef.current(chunk);
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      setStatus("capturing");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Microphone permission denied";
      setError(message);
      setStatus("error");
      stop();
    }
  }, [status, stop]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    status,
    error,
    level,
    isCapturing: status === "capturing",
    start,
    stop,
  };
}
