import { useEffect, useRef } from "react";
import gsap from "gsap";

export type AgentVisualState = "idle" | "listening" | "processing" | "speaking" | "interrupted";

export type StatusRingProps = {
  state: AgentVisualState;
  size?: number;
};

const STATE_COLORS: Record<AgentVisualState, string> = {
  idle: "#64748b",
  listening: "#22c55e",
  processing: "#f59e0b",
  speaking: "#a78bfa",
  interrupted: "#ef4444",
};

export function StatusRing({ state, size = 72 }: StatusRingProps) {
  const ringRef = useRef<SVGCircleElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const ring = ringRef.current;
    const glow = glowRef.current;
    if (!ring || !glow) return;

    gsap.killTweensOf([ring, glow]);

    const color = STATE_COLORS[state];

    // Always reset to canonical base state.
    gsap.set(ring, {
      stroke: color,
      strokeDasharray: "none",
      rotation: 0,
      attr: { "stroke-width": 3 },
      opacity: 1,
    });
    gsap.set(glow, { stroke: color, opacity: 0.15 });

    switch (state) {
      case "listening":
        gsap.to(ring, {
          attr: { "stroke-width": 5 },
          duration: 0.7,
          yoyo: true,
          repeat: -1,
          ease: "power1.inOut",
        });
        gsap.to(glow, {
          opacity: 0.55,
          duration: 0.7,
          yoyo: true,
          repeat: -1,
          ease: "power1.inOut",
        });
        break;

      case "processing":
        gsap.set(ring, { strokeDasharray: "60 200" });
        gsap.to(ring, {
          rotation: 360,
          duration: 1.2,
          ease: "none",
          repeat: -1,
        });
        break;

      case "speaking":
        gsap.to(ring, {
          attr: { "stroke-width": 4.5 },
          duration: 0.45,
          yoyo: true,
          repeat: -1,
          ease: "sine.inOut",
        });
        gsap.to(glow, {
          opacity: 0.5,
          duration: 0.45,
          yoyo: true,
          repeat: -1,
          ease: "sine.inOut",
        });
        break;

      case "interrupted":
        gsap.to(ring, {
          attr: { "stroke-width": 6 },
          duration: 0.12,
          yoyo: true,
          repeat: 5,
        });
        gsap.to(glow, {
          opacity: 0.7,
          duration: 0.12,
          yoyo: true,
          repeat: 5,
        });
        break;

      case "idle":
      default:
        break;
    }

    return () => {
      gsap.killTweensOf([ring, glow]);
    };
  }, [state]);

  const r = (size - 10) / 2;
  const c = size / 2;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
      <circle
        ref={glowRef}
        cx={c}
        cy={c}
        r={r + 4}
        fill="none"
        strokeWidth={8}
        strokeLinecap="round"
        opacity={0.2}
      />
      <circle ref={ringRef} cx={c} cy={c} r={r} fill="none" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}
