import { describe, it, expect, beforeEach } from "vitest";
import {
  assertCircuitClosed,
  recordFailure,
  recordSuccess,
  getCircuitSnapshot,
  resetAllCircuits,
  CircuitOpenError,
} from "../utils/circuit-breaker.js";

describe("circuit-breaker", () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  it("starts closed", () => {
    expect(getCircuitSnapshot("gemini").state).toBe("closed");
    expect(() => assertCircuitClosed("gemini")).not.toThrow();
  });

  it("opens after 5 consecutive failures", () => {
    for (let i = 0; i < 5; i++) recordFailure("gemini");
    const snap = getCircuitSnapshot("gemini");
    expect(snap.state).toBe("open");
    expect(snap.failures).toBe(5);
    expect(() => assertCircuitClosed("gemini")).toThrow(CircuitOpenError);
  });

  it("does not open before the threshold", () => {
    for (let i = 0; i < 4; i++) recordFailure("gemini");
    expect(getCircuitSnapshot("gemini").state).toBe("closed");
    expect(() => assertCircuitClosed("gemini")).not.toThrow();
  });

  it("success resets the breaker", () => {
    for (let i = 0; i < 3; i++) recordFailure("gemini");
    recordSuccess("gemini");
    const snap = getCircuitSnapshot("gemini");
    expect(snap.state).toBe("closed");
    expect(snap.failures).toBe(0);
  });

  it("isolates providers", () => {
    for (let i = 0; i < 5; i++) recordFailure("gemini");
    expect(() => assertCircuitClosed("gemini")).toThrow(CircuitOpenError);
    expect(() => assertCircuitClosed("elevenlabs")).not.toThrow();
    expect(() => assertCircuitClosed("deepgram")).not.toThrow();
  });

  it("rejects concurrent half-open probes", async () => {
    for (let i = 0; i < 5; i++) recordFailure("gemini");
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;

    expect(() => assertCircuitClosed("gemini")).not.toThrow();
    expect(() => assertCircuitClosed("gemini")).toThrow(CircuitOpenError);

    Date.now = realNow;
  });

  it("hands the probe slot over once it is abandoned", () => {
    for (let i = 0; i < 5; i++) recordFailure("gemini");
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      expect(() => assertCircuitClosed("gemini")).not.toThrow();
      expect(() => assertCircuitClosed("gemini")).toThrow(CircuitOpenError);

      Date.now = () => realNow() + 62_000;
      expect(() => assertCircuitClosed("gemini")).not.toThrow();
    } finally {
      Date.now = realNow;
    }
  });
});
