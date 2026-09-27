import { useEffect, useRef } from "react";
import gsap from "gsap";

export function useCardEntrance<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      gsap.set(el, { opacity: 1, y: 0 });
      return;
    }

    const tween = gsap.fromTo(
      el,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" },
    );

    return () => {
      tween.kill();
      gsap.set(el, { clearProps: "opacity,transform" });
    };
  }, []);

  return ref;
}
