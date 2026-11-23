import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/__tests__/**"],
      // About 2 points under the measured coverage (Nov 2026: 75.1 / 79.6 /
      // 70.8 / 75.1), so a real drop fails CI without flapping.
      thresholds: {
        statements: 73,
        branches: 77,
        functions: 68,
        lines: 73,
      },
    },
  },
});
