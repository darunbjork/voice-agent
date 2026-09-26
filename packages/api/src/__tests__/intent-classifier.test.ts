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
});
