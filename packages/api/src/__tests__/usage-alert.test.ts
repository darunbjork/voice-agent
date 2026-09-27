import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  incrementUsage,
  getDailyUsage,
  resetUsageMemory,
  hasAlertedToday,
  isApproachingDailyLimit,
} from "../utils/usage-tracker.js";
import { DAILY_MAX_TOKENS } from "../utils/token-budget.js";

describe("usage tracker", () => {
  beforeEach(() => {
    resetUsageMemory();
    vi.restoreAllMocks();
  });

  it("increments tokens", async () => {
    await incrementUsage({ tokens: 100 });
    const u = await getDailyUsage();
    expect(u.tokens).toBe(100);
  });

  it("isApproachingDailyLimit flips at 80%", async () => {
    expect(await isApproachingDailyLimit()).toBe(false);
    await incrementUsage({ tokens: Math.ceil(DAILY_MAX_TOKENS * 0.8) });
    expect(await isApproachingDailyLimit()).toBe(true);
  });

  it("fires the 80% alert exactly once per day", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await incrementUsage({ tokens: Math.ceil(DAILY_MAX_TOKENS * 0.8) });
    expect(hasAlertedToday()).toBe(true);
    const firstCount = warnSpy.mock.calls.length;

    await incrementUsage({ tokens: 100 });
    await incrementUsage({ tokens: 100 });
    expect(warnSpy.mock.calls.length).toBe(firstCount);

    const alertCall = warnSpy.mock.calls.find(
      ([msg]) => typeof msg === "string" && msg.includes("daily_token_80pct"),
    );
    expect(alertCall).toBeDefined();
  });

  it("does not alert below 80%", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await incrementUsage({ tokens: Math.ceil(DAILY_MAX_TOKENS * 0.5) });
    expect(hasAlertedToday()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
