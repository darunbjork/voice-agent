import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/**/*.test.ts"],
    },
    env: {
      NODE_ENV: "test",
      VOICE_MOCK: "true",
      JWT_SECRET: "test_secret_that_is_at_least_32_characters_long",
      // Do NOT hardcode DATABASE_URL / REDIS_URL here.
      // Locally: .env supplies 5434 / 6380.
      // In CI: the workflow env block supplies 5432 / 6379.
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://voiceagent:voiceagent@localhost:5434/voiceagent",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6380",
      PORT: "3001",
      FRONTEND_URL: "http://localhost:5173",
    },
    testTimeout: 10_000,
  },
});