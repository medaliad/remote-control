/**
 * Per-category global setup — prints the "TEST E2E" banner before any
 * end-to-end test file runs, so terminal output clearly demarcates this phase.
 */
export function setup(): void {
  const USE_COLOR = !process.env.NO_COLOR;
  const c = (code: string) => (USE_COLOR ? `\x1b[${code}m` : "");
  const R  = c("0");
  const BD = c("1");
  const GN = c("32");
  const DM = c("2");

  const bar   = "═".repeat(62);
  const title = " TEST E2E ";
  const sub   = " · Auto-pair full flows ";
  console.log("");
  console.log(`  ${BD}${GN}${bar}${R}`);
  console.log(`  ${BD}${GN}${title}${R}${DM}${sub}${R}`);
  console.log(`  ${BD}${GN}${bar}${R}`);
  console.log("");
}
