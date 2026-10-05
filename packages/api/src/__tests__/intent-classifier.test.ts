import { describe, it, expect } from "vitest";
import { classifyByKeywords } from "../modules/agent/intent.classifier.js";

describe("classifyByKeywords", () => {
  it("detects weather with location slot", () => {
    const r = classifyByKeywords("What is the weather in Stockholm?");
    expect(r?.intent).toBe("weather");
    expect(r?.viaFastPath).toBe(true);
    expect(r?.slots.location?.toLowerCase()).toContain("stockholm");
  });

  it("detects reminder with note slot", () => {
    const r = classifyByKeywords("Remind me to call the recruiter");
    expect(r?.intent).toBe("reminder");
    expect(r?.slots.note?.toLowerCase()).toContain("call");
  });

  it("detects translate with original and toLang slots", () => {
    const r = classifyByKeywords("Translate hello world in swedish");
    expect(r?.intent).toBe("translate");
    expect(r?.slots.original?.toLowerCase()).toContain("hello");
    expect(r?.slots.toLang).toBe("swedish");
  });

  it("detects help", () => {
    const r = classifyByKeywords("What can you do?");
    expect(r?.intent).toBe("help");
  });

  it("returns null for unknown phrases", () => {
    const r = classifyByKeywords("Tell me a joke about otters");
    expect(r).toBeNull();
  });

  it("routes 'what does <weather-word> mean in <lang>' to translate, not weather", () => {
    const r = classifyByKeywords("What does weather mean in Swedish?");
    expect(r?.intent).toBe("translate");
    expect(r?.slots.original?.toLowerCase()).toBe("weather");
    expect(r?.slots.toLang).toBe("swedish");
  });

  it("extracts the word from 'what does the word X mean in <lang>'", () => {
    const r = classifyByKeywords("What does the word high mean in Swedish?");
    expect(r?.intent).toBe("translate");
    expect(r?.slots.original?.toLowerCase()).toBe("high");
    expect(r?.slots.toLang).toBe("swedish");
  });

  it("tolerates STT mishearing 'does' as 'dose'", () => {
    const r = classifyByKeywords("What dose go mean in swedish");
    expect(r?.intent).toBe("translate");
    expect(r?.slots.original?.toLowerCase()).toBe("go");
  });

  it("handles transcripts that drop the leading 'what'", () => {
    const r = classifyByKeywords("Does the word high mean in Swedish?");
    expect(r?.intent).toBe("translate");
    expect(r?.slots.original?.toLowerCase()).toBe("high");
    expect(r?.slots.toLang).toBe("swedish");
  });

  it("extracts 'what is the meaning of X in <lang>'", () => {
    const r = classifyByKeywords("What is the meaning of well-done in German?");
    expect(r?.intent).toBe("translate");
    expect(r?.slots.original?.toLowerCase()).toBe("well-done");
    expect(r?.slots.toLang).toBe("german");
  });

  it("still detects weather in meaning-free questions", () => {
    const r = classifyByKeywords("Does it rain tomorrow?");
    expect(r?.intent).toBe("weather");
  });
});
