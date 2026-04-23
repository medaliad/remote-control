#!/usr/bin/env node
/**
 * rc-host — one-command launcher for the Remote Control host.
 *
 * Usage:
 *   npm run host
 *   npm run host -- --relay wss://relay.example.com/relay
 *   node bin/rc-host.mjs --relay wss://relay.example.com/relay --port 3000
 *
 * Flags:
 *   --relay <url>   WebSocket URL to register with. Persists to config.json
 *                   so future launches pick it up without the flag.
 *   --port  <n>     Port for the combined web + relay server (default 3000).
 *   --no-browser    Don't auto-open the browser.
 *   -h / --help     Show this message.
 *
 * What this does, so a user never has to run more than a single command:
 *   1. starts the combined web+relay server (port $PORT, default 3000)
 *   2. starts the host agent as a child, registered with the chosen relay
 *   3. waits for both to be healthy
 *   4. opens the default browser to /host
 *   5. on Ctrl-C cleanly stops both
 *
 * Zero deps — uses only built-in node modules.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

// ─── Arg parsing (tiny, zero-dep) ─────────────────────────────────────────────

function parseArgs(argv) {
  const out = { relay: null, port: null, noBrowser: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "--no-browser" || a === "--no-open") { out.noBrowser = true; continue; }
    if (a === "--relay" && next && !next.startsWith("-")) { out.relay = next; i++; continue; }
    if (a.startsWith("--relay=")) { out.relay = a.slice("--relay=".length); continue; }
    if (a === "--port" && next && !next.startsWith("-")) { out.port = next; i++; continue; }
    if (a.startsWith("--port=")) { out.port = a.slice("--port=".length); continue; }
    // ignore unknowns for forward-compat
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
`rc-host — one-command launcher for the Remote Control host.

Usage:
  npm run host                                    start with saved or default settings
  npm run host -- --relay wss://host/relay        set & persist the relay URL
  npm run host -- --port 3001                     use a different port
  npm run host -- --no-browser                    don't open a browser tab

Persisted settings live in:
  Windows : %APPDATA%\\remote-control\\config.json
  macOS/Linux : $XDG_CONFIG_HOME/remote-control/config.json  (fallback ~/.config/…)
`);
  process.exit(0);
}

const PORT       = Number(args.port ?? process.env.PORT ?? 3000);
const LOCAL_PORT = Number(process.env.LOCAL_PORT ?? 4001);
const OPEN_BROWSER = !args.noBrowser && !process.env.NO_BROWSER;

// ─── Persist relay URL if --relay was passed ──────────────────────────────────
// Must match apps/host/src/infrastructure/host-config.ts exactly, so the host
// agent that starts below reads the same file.

function configDir() {
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "remote-control");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "remote-control");
}

function loadConfig() {
  const file = join(configDir(), "config.json");
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

function saveConfig(patch) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const merged = { ...loadConfig(), ...patch };
  writeFileSync(join(dir, "config.json"), JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

if (args.relay) {
  saveConfig({ relayUrl: args.relay });
  process.stdout.write(`[rc-host] saved relay → ${args.relay}\n`);
}

const persistedRelay = loadConfig().relayUrl;
const RELAY_URL = process.env.RELAY_URL ?? persistedRelay ?? `ws://localhost:${PORT}/relay`;

// ─── Pretty prefixed output ───────────────────────────────────────────────────

const COLORS = { reset: "\x1b[0m", bold: "\x1b[1m", cyan: "\x1b[36m", yellow: "\x1b[33m", gray: "\x1b[90m", green: "\x1b[32m", red: "\x1b[31m" };
const tag = (label, color) => `${COLORS.bold}${color}[${label}]${COLORS.reset} `;
const info = (msg)  => process.stdout.write(`${tag("rc-host", COLORS.cyan)}${msg}\n`);
const warn = (msg)  => process.stdout.write(`${tag("rc-host", COLORS.yellow)}${msg}\n`);
const die  = (msg, code = 1) => { process.stderr.write(`${tag("rc-host", COLORS.red)}${msg}\n`); process.exit(code); };

// ─── Preflight: make sure the Next build + node_modules are present ──────────

function preflight() {
  if (!existsSync(join(ROOT, "node_modules"))) {
    die("node_modules/ missing. Run `npm install` in " + ROOT + " first.");
  }
  if (!existsSync(join(ROOT, "apps", "web", ".next"))) {
    warn("No built web UI found — running `npm run build:combined` first (one-time).");
    const build = spawn(npmCmd(), ["run", "build:combined"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    return new Promise((resolveBuild, rejectBuild) => {
      build.on("exit", (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`build exited ${code}`)));
    });
  }
  return Promise.resolve();
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

// ─── Child process helpers ────────────────────────────────────────────────────

/** Spawn a child, prefix its stdout/stderr with a coloured tag. */
function startChild(label, color, cmd, cmdArgs, extraEnv) {
  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv, FORCE_COLOR: "1" },
  });
  const prefix = tag(label, color);
  const line = (buf) => {
    for (const part of buf.toString("utf8").split(/\r?\n/)) {
      if (part.length) process.stdout.write(prefix + part + "\n");
    }
  };
  child.stdout.on("data", line);
  child.stderr.on("data", line);
  return child;
}

// ─── Readiness polling ────────────────────────────────────────────────────────

async function waitForUrl(url, { timeoutMs = 30_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─── Open the default browser ─────────────────────────────────────────────────

function openBrowser(url) {
  try {
    const p = platform();
    if (p === "win32")  spawn("cmd",       ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else if (p === "darwin") spawn("open",  [url], { stdio: "ignore", detached: true }).unref();
    else                spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch (err) {
    warn("Could not auto-open browser: " + (err?.message ?? err));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await preflight();

  info(`starting combined web+relay on :${PORT}`);
  const server = startChild("web  ", COLORS.cyan, process.execPath, ["combined-server.mjs"], { PORT: String(PORT) });

  info(`starting host agent  relay=${RELAY_URL}`);
  const host = startChild("host ", COLORS.yellow, npmCmd(), ["--workspace", "apps/host", "run", "start"], {
    RELAY_URL,
    LOCAL_PORT: String(LOCAL_PORT),
    WEB_PORT:   String(PORT),
  });

  const shutdown = (signal) => {
    info(`received ${signal}, shutting down…`);
    for (const c of [host, server]) { try { c.kill(); } catch { /* ignore */ } }
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  for (const [child, name] of [[server, "web/relay"], [host, "host agent"]]) {
    child.on("exit", (code, sig) => {
      info(`${name} exited (code=${code}, signal=${sig ?? "none"}) — stopping rc-host`);
      shutdown("child-exit");
    });
  }

  info("waiting for web UI…");
  const webOk = await waitForUrl(`http://localhost:${PORT}/`);
  if (!webOk) warn(`web UI didn't respond on :${PORT} within 30s — still trying`);

  info("waiting for host agent…");
  const hostOk = await waitForUrl(`http://localhost:${LOCAL_PORT}/info`);
  if (!hostOk) warn(`host agent didn't respond on :${LOCAL_PORT} within 30s — still trying`);

  const hostUrl = `http://localhost:${PORT}/host`;
  info(`${COLORS.green}${COLORS.bold}ready${COLORS.reset}  →  ${hostUrl}`);

  if (OPEN_BROWSER) openBrowser(hostUrl);
  else              info("NO_BROWSER / --no-browser set — not auto-opening");
}

main().catch((err) => die(err?.stack ?? String(err)));
