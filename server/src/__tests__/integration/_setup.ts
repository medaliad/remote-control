/**
 * Per-category global setup — prints the "TEST INTEGRATION" banner before any
 * integration test file runs, so terminal output clearly demarcates this phase.
 */
export function setup(): void {
  const USE_COLOR = !process.env.NO_COLOR;
  const c = (code: string) => (USE_COLOR ? `\x1b[${code}m` : "");
  const R  = c("0");
  const BD = c("1");
  const CY = c("36");
  const DM = c("2");

  const bar   = "═".repeat(62);
  const title = " TEST INTEGRATION ";
  const sub   = " · REST API · /ws · /agent ";
  console.log("");
  console.log(`  ${BD}${CY}${bar}${R}`);
  console.log(`  ${BD}${CY}${title}${R}${DM}${sub}${R}`);
  console.log(`  ${BD}${CY}${bar}${R}`);
  console.log("");
}
