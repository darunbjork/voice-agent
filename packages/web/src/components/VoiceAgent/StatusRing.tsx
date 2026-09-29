import { useEffect, useRef } from "react";
import gsap from "gsap";
import type { AgentState } from "../../state/agent-state.js";
import { STATE_RING_COLORS, STATIC_RING_SPECS } from "../../lib/status-ring.js";
import { useReducedMotion } from "../../lib/motion.js";

export type StatusRingProps = {
  state: AgentState;
  size?: number;
};

export function StatusRing({ state, size = 72 }: StatusRingProps) {
  const ringRef = useRef<SVGCircleElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const ring = ringRef.current;
    const glow = glowRef.current;
    if (!ring || !glow) return;

    gsap.killTweensOf([ring, glow]);

    const color = STATE_RING_COLORS[state];

    if (reduce) {
      const spec = STATIC_RING_SPECS[state];
      gsap.set(ring, {
        stroke: color,
        strokeDasharray: spec.dasharray ?? "none",
        rotation: 0,
        opacity: 1,
        attr: { "stroke-width": spec.strokeWidth },
      });
      gsap.set(glow, { stroke: color, opacity: spec.glowOpacity });
      return () => {
        gsap.killTweensOf([ring, glow]);
      };
    }

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

      case "error":
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

      case "disconnected":
        break;

      case "idle":
      default:
        gsap.to(glow, {
          opacity: 0.42,
          duration: 2.4,
          yoyo: true,
          repeat: -1,
          ease: "sine.inOut",
        });
        break;
    }

    return () => {
      gsap.killTweensOf([ring, glow]);
    };
  }, [state, reduce]);

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
