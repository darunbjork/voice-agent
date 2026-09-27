import { describe, it, expect, vi } from "vitest";

describe("getCorsOrigin", () => {
  it("returns localhost origins in development", async () => {
    vi.resetModules();
    vi.doMock("../env.js", () => ({
      env: { NODE_ENV: "development", CORS_ORIGINS: undefined },
    }));
    const { getCorsOrigin } = await import("../config/cors.js");
    const origin = getCorsOrigin();
    expect(Array.isArray(origin)).toBe(true);
    expect(origin).toContain("http://localhost:5173");
  });

  it("returns false when production has no allowlist", async () => {
    vi.resetModules();
    vi.doMock("../env.js", () => ({
      env: { NODE_ENV: "production", CORS_ORIGINS: undefined },
    }));
    const { getCorsOrigin } = await import("../config/cors.js");
    expect(getCorsOrigin()).toBe(false);
  });

  it("parses comma-separated allowlist in production", async () => {
    vi.resetModules();
    vi.doMock("../env.js", () => ({
      env: {
        NODE_ENV: "production",
        CORS_ORIGINS: "https://a.example,https://b.example",
      },
    }));
    const { getCorsOrigin } = await import("../config/cors.js");
    const origin = getCorsOrigin();
    expect(origin).toEqual(["https://a.example", "https://b.example"]);
  });
});
