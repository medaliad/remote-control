/**
 * Per-category global setup — prints the "TEST UNIT" banner before any unit
 * test file runs, so terminal output clearly demarcates the unit phase.
 */
export function setup(): void {
  const USE_COLOR = !process.env.NO_COLOR;
  const c = (code: string) => (USE_COLOR ? `\x1b[${code}m` : "");
  const R  = c("0");
  const BD = c("1");
  const MG = c("35");
  const DM = c("2");

  const bar   = "═".repeat(62);
  const title = " TEST UNIT ";
  const sub   = " · SessionManager · code generation ";
  console.log("");
  console.log(`  ${BD}${MG}${bar}${R}`);
  console.log(`  ${BD}${MG}${title}${R}${DM}${sub}${R}`);
  console.log(`  ${BD}${MG}${bar}${R}`);
  console.log("");
}
