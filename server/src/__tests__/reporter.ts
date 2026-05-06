/**
 * Custom Vitest reporter.
 *
 * Wraps the built-in verbose reporter so every test line is shown, then adds
 * a branded summary table at the end listing each file with its pass/fail counts.
 */
import { VerboseReporter } from "vitest/reporters";
import type { File, Task } from "vitest";

function countTasks(tasks: Task[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const task of tasks) {
    if (task.type === "test" || task.type === "custom") {
      if (task.result?.state === "pass") passed++;
      else if (task.result?.state === "fail") failed++;
    }
    if ("tasks" in task && task.tasks) {
      const sub = countTasks(task.tasks);
      passed += sub.passed;
      failed += sub.failed;
    }
  }
  return { passed, failed };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export default class PresentationReporter extends VerboseReporter {
  override onFinished(files: File[] = [], errors: unknown[] = []): void {
    // Let the parent write its own footer first
    super.onFinished(files, errors);

    const USE_COLOR = !process.env.NO_COLOR;
    const c = (code: string) => (USE_COLOR ? `\x1b[${code}m` : "");
    const R  = c("0");
    const BD = c("1");
    const DM = c("2");
    const CY = c("36");
    const GN = c("32");
    const RD = c("31");

    let totalPassed = 0;
    let totalFailed = 0;

    const rows: string[] = [];
    for (const file of files) {
      const { passed, failed } = countTasks(file.tasks);
      totalPassed += passed;
      totalFailed += failed;

      const total   = passed + failed;
      const icon    = failed === 0 ? `${GN}✓${R}` : `${RD}✗${R}`;
      // strip the full path down to just src/__tests__/...
      const name    = file.name.replace(/.*__tests__[\\/]/, "");
      const score   = `${failed === 0 ? GN : RD}${passed}/${total}${R}`;
      rows.push(`  ${DM}║${R}  ${icon}  ${pad(name, 38)} ${score}   ${DM}║${R}`);
    }

    const allPass  = totalFailed === 0;
    const status   = allPass
      ? `${GN}${BD}  ✓  ALL ${totalPassed} TESTS PASSED${R}`
      : `${RD}${BD}  ✗  ${totalFailed} FAILED  /  ${totalPassed} PASSED${R}`;

    const divider  = `  ${DM}╠══════════════════════════════════════════════════════╣${R}`;

    console.log([
      "",
      `  ${DM}╔══════════════════════════════════════════════════════╗${R}`,
      `  ${DM}║${R}  ${status}${"".padEnd(Math.max(0, 28 - totalPassed.toString().length))}  ${DM}║${R}`,
      divider,
      `  ${DM}║${R}  ${CY}File${R}${pad("", 36)} ${CY}Passed${R}  ${DM}║${R}`,
      divider,
      ...rows,
      divider,
      `  ${DM}║${R}  ${BD}Total:  ${totalPassed} passed,  ${totalFailed} failed${R}${"".padEnd(18)}  ${DM}║${R}`,
      `  ${DM}╚══════════════════════════════════════════════════════╝${R}`,
      "",
    ].join("\n"));
  }
}
