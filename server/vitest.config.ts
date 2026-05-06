import { defineConfig } from "vitest/config";

/**
 * Vitest config for the signalling server.
 *
 * The test suite is split into three categories:
 *
 *    unit/         pure logic (SessionManager, code generation)
 *    integration/  HTTP + WebSocket servers wired up
 *    e2e/          end-to-end auto-pair flows
 *
 * Run all three with `npm test` (each category prints its own banner).
 * Run a single category with `npm run test:unit`, `:integration`, or `:e2e`.
 *
 * The category is selected via the `TEST_CATEGORY` env var, set by the runner
 * script in `scripts/run-tests.mjs`.
 */

const category = process.env.TEST_CATEGORY?.toLowerCase();
const isCategoryRun = category === "unit" || category === "integration" || category === "e2e";

const include = isCategoryRun
  ? [`src/__tests__/${category}/**/*.test.ts`]
  : ["src/__tests__/**/*.test.ts"];

const globalSetup = isCategoryRun
  ? [`./src/__tests__/${category}/_setup.ts`]
  : ["./src/__tests__/global-setup.ts"];

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include,
    testTimeout: 10_000,
    hookTimeout: 10_000,

    // Banner printed once before the suite starts (umbrella for full runs,
    // category-specific for `test:unit` / `:integration` / `:e2e`).
    globalSetup,

    // Custom reporter (extends VerboseReporter) + fallback for non-TTY
    reporters: process.env.CI
      ? ["verbose"]
      : ["./src/__tests__/reporter.ts"],

    // Show stdout/console.log for every test (not just failing ones)
    onConsoleLog: () => true,

    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
});
