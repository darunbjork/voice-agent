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
      PORT: "3001",
      FRONTEND_URL: "http://localhost:5173",
    },
    testTimeout: 10_000,
  },
});