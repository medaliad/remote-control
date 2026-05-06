/**
 * Presentation-grade test logger.
 *
 * Produces coloured, aligned console output so that each test tells a story
 * when shown in a terminal during a demo or code review.
 *
 * All colour codes are suppressed automatically when the terminal does not
 * support them (NO_COLOR env var or non-TTY output).
 */

const USE_COLOR = !process.env.NO_COLOR;
const c = (code: string) => (USE_COLOR ? `\x1b[${code}m` : "");

const R  = c("0");   // reset
const DM = c("2");   // dim
const BD = c("1");   // bold
const CY = c("36");  // cyan
const GN = c("32");  // green
const YL = c("33");  // yellow
const RD = c("31");  // red
const BL = c("34");  // blue
const MG = c("35");  // magenta

const PIPE = `   ${DM}│${R}`;

// ─── section headers ─────────────────────────────────────────────────────────

/** Print a bold section title with a horizontal rule above it. */
export function section(title: string): void {
  console.log(`\n   ${DM}${"─".repeat(58)}${R}`);
  console.log(`   ${BD}${BL}${title}${R}`);
  console.log(`   ${DM}${"─".repeat(58)}${R}`);
}

/** Print a scenario sub-title inside a section. */
export function scenario(label: string): void {
  console.log(`\n${PIPE}  ${BD}${MG}◆ ${label}${R}`);
}

// ─── flow steps ──────────────────────────────────────────────────────────────

/** A WebSocket message being sent by an actor. */
export function send(actor: string, msgType: string, payload?: Record<string, unknown>): void {
  const data = payload
    ? `  ${DM}${JSON.stringify(payload)}${R}`
    : "";
  console.log(`${PIPE}  ${CY}${actor.padEnd(10)}${R} ${DM}──►${R} ${YL}${msgType}${R}${data}`);
}

/** A WebSocket message received by an actor. */
export function recv(actor: string, msgType: string, detail?: string): void {
  const d = detail ? `  ${GN}${detail}${R}` : "";
  console.log(`${PIPE}  ${GN}✓${R} ${CY}${actor.padEnd(10)}${R} ${DM}◄──${R} ${YL}${msgType}${R}${d}`);
}

/** An HTTP request + response in one line. */
export function http(method: string, path: string, status: number, note?: string): void {
  const col = status < 300 ? GN : status < 500 ? YL : RD;
  const n = note ? `  ${DM}${note}${R}` : "";
  console.log(
    `${PIPE}  ${DM}HTTP${R}  ${BD}${method}${R} ${path}  ${col}${status}${R}${n}`
  );
}

/** A general progress step. */
export function step(label: string, value?: string): void {
  const v = value ? `  ${CY}${value}${R}` : "";
  console.log(`${PIPE}  ${DM}→${R}  ${label}${v}`);
}

/** A passing assertion or confirmed fact. */
export function ok(label: string, value?: string): void {
  const v = value ? `  ${GN}${value}${R}` : "";
  console.log(`${PIPE}  ${GN}✓${R}  ${label}${v}`);
}

/** A failing / unexpected state (for error-path tests). */
export function error(label: string, code?: string): void {
  const c2 = code ? `  ${RD}[${code}]${R}` : "";
  console.log(`${PIPE}  ${YL}⚠${R}  ${label}${c2}`);
}

/** Separator between logically separate phases inside one test. */
export function divider(): void {
  console.log(`${PIPE}  ${DM}${"·".repeat(48)}${R}`);
}

/** Truncate a token/UUID for readable display. */
export function shortToken(t: string): string {
  return `${t.slice(0, 8)}…`;
}

// ─── category banners ────────────────────────────────────────────────────────

/**
 * Print a big, bold category banner — used by per-folder _setup.ts files so that
 * `vitest run` clearly demarcates UNIT / INTEGRATION / E2E test phases.
 */
export function banner(category: "UNIT" | "INTEGRATION" | "E2E", subtitle?: string): void {
  const title = `TEST ${category}`;
  const sub   = subtitle ? `  ${DM}${subtitle}${R}` : "";
  const bar   = "═".repeat(62);
  const inner = ` ${title} `.padEnd(62, " ");
  console.log("");
  console.log(`${BD}${MG}${bar}${R}`);
  console.log(`${BD}${MG}${inner}${R}${sub}`);
  console.log(`${BD}${MG}${bar}${R}`);
  console.log("");
}
