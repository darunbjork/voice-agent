import { useEffect, useRef } from "react";
import { computeBarHeights, MIN_BAR_HEIGHT } from "../../lib/waveform.js";
import { useReducedMotion } from "../../lib/motion.js";

export type WaveformCanvasProps = {
  bufferRef: React.RefObject<number[]>;
  color?: string;
  background?: string;
  width?: number;
  height?: number;
  barCount?: number;
};

export function WaveformCanvas({
  bufferRef,
  color = "#a78bfa",
  background = "transparent",
  width = 280,
  height = 56,
  barCount = 64,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const colorRef = useRef(color);
  colorRef.current = color;
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.scale(dpr, dpr);

    const barWidth = width / barCount;
    const gap = Math.max(1, barWidth * 0.25);
    const effectiveWidth = Math.max(1, barWidth - gap);

    const draw = (): void => {
      const samples = bufferRef.current ?? [];
      const heights = computeBarHeights(samples, barCount, height, reduced);
      ctx.clearRect(0, 0, width, height);

      if (background !== "transparent") {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
      }

      const offset = barCount - heights.length;
      ctx.fillStyle = colorRef.current;

      for (let i = 0; i < heights.length; i++) {
        const barHeight = heights[i] ?? MIN_BAR_HEIGHT;
        const x = (offset + i) * barWidth;
        const y = (height - barHeight) / 2;

        ctx.beginPath();
        ctx.roundRect(x, y, effectiveWidth, barHeight, 2);
        ctx.fill();
      }

      if (!reduced) {
        rafRef.current = requestAnimationFrame(draw);
      }
    };

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [bufferRef, background, width, height, barCount, reduced]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width,
        height,
        display: "block",
        borderRadius: 8,
      }}
    />
  );
}
