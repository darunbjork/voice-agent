import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    globalSetup: ["src/__tests__/support/global-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/**/*.test.ts", "src/__tests__/**"],
      // About 2 points under the measured coverage (Nov 2026: 90.3 / 84.9 /
      // 93.9 / 90.3), so a real drop fails CI without flapping.
      thresholds: {
        statements: 88,
        branches: 82,
        functions: 91,
        lines: 88,
      },
    },
    env: {
      NODE_ENV: "test",
      VOICE_MOCK: "true",
      // Never reach the real Groq API from tests, even if a local .env has a key
      // (dotenv does not override variables that are already set).
      GROQ_API_KEY: "",
      JWT_SECRET: "test_secret_that_is_at_least_32_characters_long",
      PORT: "3001",
      FRONTEND_URL: "http://localhost:5173",
      // The audio WebSocket rejects upgrades from origins outside this list.
      CORS_ORIGINS: "http://localhost:5173",
    },
    testTimeout: 10_000,
  },
});
