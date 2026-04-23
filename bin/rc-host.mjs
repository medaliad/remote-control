#!/usr/bin/env node
/**
 * rc-host — one-command launcher for the Remote Control host.
 *
 * What this does, so a user never has to run more than a single command:
 *   1. starts the combined web+relay server (port $PORT, default 3000)
 *   2. starts the host agent as a child, pointed at ws://localhost:<port>/relay
 *   3. waits for both to be healthy
 *   4. opens the default browser to /host so the user sees PIN + device name
 *   5. on Ctrl-C (or SIGTERM from a service manager) cleanly stops both
 *
 * Zero deps — uses only built-in node modules. Safe to run as a login item,
 * launchd agent, systemd --user unit, or Windows Startup shortcut.
 *
 * Env vars you can override (all optional):
 *   PORT         combined server port (default 3000)
 *   LOCAL_PORT   host-agent loopback info port (default 4001)
 *   DEVICE_NAME  override display name (default OS hostname)
 *   RELAY_URL    point the host at a different relay (default ws://localhost:${PORT}/relay)
 *   NO_BROWSER   set to any non-empty value to suppress auto-open
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { platform } from "node:os";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

const PORT       = Number(process.env.PORT ?? 3000);
const LOCAL_PORT = Number(process.env.LOCAL_PORT ?? 4001);
const RELAY_URL  = process.env.RELAY_URL ?? `ws://localhost:${PORT}/relay`;
const OPEN_BROWSER = !process.env.NO_BROWSER;

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
function startChild(label, color, cmd, args, extraEnv) {
  const child = spawn(cmd, args, {
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

  info(`starting host agent (relay = ${RELAY_URL})`);
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
  if (!webOk) { warn(`web UI didn't respond on :${PORT} within 30s — still trying`); }

  info("waiting for host agent…");
  const hostOk = await waitForUrl(`http://localhost:${LOCAL_PORT}/info`);
  if (!hostOk) { warn(`host agent didn't respond on :${LOCAL_PORT} within 30s — still trying`); }

  const hostUrl = `http://localhost:${PORT}/host`;
  info(`${COLORS.green}${COLORS.bold}ready${COLORS.reset}  →  ${hostUrl}`);

  if (OPEN_BROWSER) {
    openBrowser(hostUrl);
  } else {
    info("NO_BROWSER set — not auto-opening");
  }
}

main().catch((err) => die(err?.stack ?? String(err)));
