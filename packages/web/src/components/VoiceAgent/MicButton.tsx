import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { playFeedbackTone } from "../../lib/feedback-tone.js";

const HOLD_THRESHOLD_MS = 180;
const MIC_HINT_ID = "mic-button-hint";

export type MicButtonVariant = "idle" | "listening" | "speaking" | "interrupted";

export type MicButtonProps = {
  isCapturing: boolean;
  disabled?: boolean;
  onStart: () => void | Promise<void>;
  onStop: () => void;
  variant?: MicButtonVariant;
};

export function MicButton({
  isCapturing,
  disabled = false,
  onStart,
  onStop,
  variant = "idle",
}: MicButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [holdActive, setHoldActive] = useState(false);

  const isCapturingRef = useRef(isCapturing);
  isCapturingRef.current = isCapturing;

  const pointerIdRef = useRef<number | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdFiredRef = useRef(false);

  const wantCaptureRef = useRef(false);
  const pendingStartRef = useRef<Promise<void> | null>(null);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const startCapture = useCallback(() => {
    wantCaptureRef.current = true;
    if (isCapturingRef.current || pendingStartRef.current) return;

    playFeedbackTone("listen-start");

    const p = Promise.resolve(onStart());
    pendingStartRef.current = p;

    void p
      .catch(() => {
        wantCaptureRef.current = false;
      })
      .finally(() => {
        if (pendingStartRef.current === p) pendingStartRef.current = null;
        if (!wantCaptureRef.current && isCapturingRef.current) {
          onStop();
        }
      });
  }, [onStart, onStop]);

  const stopCapture = useCallback(() => {
    wantCaptureRef.current = false;
    if (pendingStartRef.current) {
      return;
    }
    if (isCapturingRef.current) {
      playFeedbackTone("listen-stop");
      onStop();
    }
  }, [onStop]);

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      e.preventDefault();
      pointerIdRef.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      setPressed(true);
      holdFiredRef.current = false;

      clearHoldTimer();
      holdTimerRef.current = setTimeout(() => {
        holdFiredRef.current = true;
        setHoldActive(true);
        if (!isCapturingRef.current) startCapture();
      }, HOLD_THRESHOLD_MS);
    },
    [disabled, startCapture, clearHoldTimer],
  );

  const endPress = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (pointerIdRef.current !== e.pointerId) return;

      clearHoldTimer();
      setPressed(false);
      setHoldActive(false);
      pointerIdRef.current = null;

      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {}

      if (holdFiredRef.current) {
        holdFiredRef.current = false;
        stopCapture();
        return;
      }

      if (isCapturingRef.current) stopCapture();
      else startCapture();
    },
    [clearHoldTimer, startCapture, stopCapture],
  );

  const handlePointerCancel = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      clearHoldTimer();
      setPressed(false);
      setHoldActive(false);
      holdFiredRef.current = false;
      pointerIdRef.current = null;
      stopCapture();

      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {}
    },
    [clearHoldTimer, stopCapture],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (disabled || e.repeat) return;
      if (isCapturingRef.current) stopCapture();
      else startCapture();
    },
    [disabled, startCapture, stopCapture],
  );

  useEffect(() => {
    return () => {
      clearHoldTimer();
    };
  }, [clearHoldTimer]);

  const displayActive = isCapturing || pressed;
  const ringColor =
    variant === "interrupted"
      ? "var(--error)"
      : variant === "speaking"
        ? "var(--iris-soft)"
        : displayActive
          ? "var(--success)"
          : "var(--muted)";

  const label = isCapturing
    ? holdActive
      ? "Release to stop"
      : "Listening — click to stop"
    : pressed
      ? "Keep holding for push-to-talk"
      : "Click to talk · hold for push-to-talk";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        marginBottom: "0.75rem",
      }}
    >
      <button
        type="button"
        disabled={disabled}
        className={displayActive ? "mic-button is-active" : "mic-button"}
        aria-label={isCapturing ? "Stop microphone" : "Start microphone"}
        aria-pressed={isCapturing}
        aria-describedby={MIC_HINT_ID}
        onPointerDown={handlePointerDown}
        onPointerUp={endPress}
        onPointerCancel={handlePointerCancel}
        onKeyDown={handleKeyDown}
        style={{
          width: 72,
          height: 72,
          borderRadius: "50%",
          border: `2px solid ${ringColor}`,
          background: displayActive ? "rgba(34, 197, 94, 0.15)" : "var(--surface-2)",
          color: ringColor,
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: displayActive ? `0 0 0 6px ${ringColor}22` : "none",
          transform: pressed ? "scale(0.96)" : "scale(1)",
          transition:
            "transform 80ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease",
          touchAction: "none",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          <path
            d="M12 1.75a3.25 3.25 0 0 0-3.25 3.25v6a3.25 3.25 0 1 0 6.5 0v-6A3.25 3.25 0 0 0 12 1.75Z"
            fill="currentColor"
          />
          <path
            d="M7 11a5 5 0 0 0 10 0"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          <path d="M12 16v3.25" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          <path d="M9 19.25h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </button>
      <span
        id={MIC_HINT_ID}
        style={{
          fontSize: 11,
          color: "var(--muted)",
          textAlign: "center",
          maxWidth: 200,
          lineHeight: 1.35,
        }}
      >
        {label}
      </span>
    </div>
  );
}
