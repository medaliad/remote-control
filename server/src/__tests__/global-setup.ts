/**
 * Global setup — executed once before the entire test suite.
 * Prints the presentation banner to the terminal.
 */
export function setup(): void {
  const USE_COLOR = !process.env.NO_COLOR;
  const c = (code: string) => (USE_COLOR ? `\x1b[${code}m` : "");
  const R  = c("0");
  const BD = c("1");
  const CY = c("36");
  const DM = c("2");

  const lines = [
    "",
    `  ${DM}╔══════════════════════════════════════════════════════════════════╗${R}`,
    `  ${DM}║${R}                                                                  ${DM}║${R}`,
    `  ${DM}║${R}  ${BD}${CY}  VE Admin · Remote Control Server · Automated Test Suite  ${R}  ${DM}║${R}`,
    `  ${DM}║${R}                                                                  ${DM}║${R}`,
    `  ${DM}╠══════════════════════════════════════════════════════════════════╣${R}`,
    `  ${DM}║${R}  Coverage areas:                                                 ${DM}║${R}`,
    `  ${DM}║${R}    ${CY}Unit${R}          SessionManager · Code generation                ${DM}║${R}`,
    `  ${DM}║${R}    ${CY}Integration${R}   REST API · /ws WebSocket · /agent WebSocket     ${DM}║${R}`,
    `  ${DM}║${R}    ${CY}E2E${R}           Auto-pair full flow (both orderings)             ${DM}║${R}`,
    `  ${DM}║${R}                                                                  ${DM}║${R}`,
    `  ${DM}║${R}  Stack:  ${CY}Node 20 · TypeScript · WebSocket (ws) · Vitest 2${R}        ${DM}║${R}`,
    `  ${DM}║${R}                                                                  ${DM}║${R}`,
    `  ${DM}╚══════════════════════════════════════════════════════════════════╝${R}`,
    "",
  ];
  console.log(lines.join("\n"));
}
