import { describe, it, expect } from "vitest";
import { env } from "../env.js";

describe("provider safety", () => {
  it("runs with VOICE_MOCK=true", () => {
    expect(env.VOICE_MOCK).toBe(true);
  });

  it("runs with NODE_ENV=test", () => {
    expect(env.NODE_ENV).toBe("test");
  });
});