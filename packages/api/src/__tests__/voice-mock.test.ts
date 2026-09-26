import { describe, it, expect } from "vitest";
import {
  mockTranscriptFinal,
  mockGeminiOutput,
  mockAgentReply,
  mockTtsChunk,
} from "../utils/voice-mock.js";

describe("voice-mock", () => {
  it("returns deterministic transcript", () => {
    const a = mockTranscriptFinal();
    const b = mockTranscriptFinal();
    expect(a.text).toBe(b.text);
    expect(a.latencyMs).toBeGreaterThan(0);
  });

  it("returns a weather card for weather intent", () => {
    const out = mockGeminiOutput("weather");
    expect(out.intent).toBe("weather");
    expect(out.card).not.toBeNull();
    expect(out.card?.type).toBe("weather");
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it("returns help card for help intent", () => {
    const out = mockGeminiOutput("help");
    expect(out.intent).toBe("help");
    expect(out.card?.type).toBe("help");
  });

  it("builds a full AgentReply with latency breakdown", () => {
    const reply = mockAgentReply("sess_123", 1, "weather");
    expect(reply.sessionId).toBe("sess_123");
    expect(reply.turnIndex).toBe(1);
    expect(reply.latencyMs.total).toBeGreaterThan(0);
    expect(reply.card?.type).toBe("weather");
  });

  it("produces a TTS chunk with ArrayBuffer audio", () => {
    const chunk = mockTtsChunk(0);
    expect(chunk.sequenceNum).toBe(0);
    expect(chunk.audio).toBeInstanceOf(ArrayBuffer);
    expect(chunk.audio.byteLength).toBeGreaterThan(0);
  });
});
