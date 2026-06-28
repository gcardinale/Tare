import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts", "src/cli/**", "src/**/*.io.ts"],
      thresholds: {
        // Core puro: vedi ai/coding_rules.md (target >= 90%).
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
