#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 *   node scripts/run-tests.mjs              # umbrella banner + unit + integration + e2e
 *   node scripts/run-tests.mjs unit         # only unit tests, with TEST UNIT banner
 *   node scripts/run-tests.mjs integration  # only integration, with TEST INTEGRATION banner
 *   node scripts/run-tests.mjs e2e          # only e2e, with TEST E2E banner
 *
 * The TEST_CATEGORY env var is read by vitest.config.ts to scope the test
 * include glob and pick the right per-category global-setup banner.
 */
import { spawnSync } from "node:child_process";

const CATEGORIES = ["unit", "integration", "e2e"];
const VITEST_CMD = process.platform === "win32" ? "vitest.cmd" : "vitest";

function runVitest(category) {
  const env = { ...process.env };
  if (category) env.TEST_CATEGORY = category;
  const r = spawnSync(VITEST_CMD, ["run"], {
    stdio: "inherit",
    env,
    shell: true,
  });
  return r.status ?? 1;
}

function printUmbrella() {
  const useColor = !process.env.NO_COLOR;
  const c = (code) => (useColor ? `\x1b[${code}m` : "");
  const R = c("0");
  const BD = c("1");
  const CY = c("36");
  const DM = c("2");
  const bar = "═".repeat(68);
  console.log("");
  console.log(`  ${DM}╔${bar}╗${R}`);
  console.log(`  ${DM}║${R}  ${BD}${CY}VE Admin · Remote Control Server · Automated Test Suite${R}     ${DM}║${R}`);
  console.log(`  ${DM}║${R}  ${DM}Running:  unit  →  integration  →  e2e${R}                       ${DM}║${R}`);
  console.log(`  ${DM}╚${bar}╝${R}`);
  console.log("");
}

const arg = (process.argv[2] ?? "").toLowerCase();

if (arg && !CATEGORIES.includes(arg)) {
  console.error(`Unknown category "${arg}". Valid: ${CATEGORIES.join(", ")}`);
  process.exit(2);
}

if (arg) {
  // Single-category run — vitest's globalSetup will print the category banner
  process.exit(runVitest(arg));
} else {
  // Full run — print umbrella, then run each category in sequence
  printUmbrella();
  for (const cat of CATEGORIES) {
    const code = runVitest(cat);
    if (code !== 0) process.exit(code);
  }
}
