#!/usr/bin/env node
/**
 * dev.mjs — starts relay, host, and web in parallel with coloured prefixed output.
 * Zero external dependencies: uses Node.js built-in child_process.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// ─── colour helpers ──────────────────────────────────────────────────────────
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[34m"]; // cyan, yellow, blue

function prefix(label, color) {
  return `${BOLD}${color}[${label}]${RESET} `;
}

// ─── process definitions ─────────────────────────────────────────────────────
const processes = [
  { label: "relay", cmd: "npm", args: ["--workspace", "apps/signaling", "run", "dev"] },
  { label: "host ", cmd: "npm", args: ["--workspace", "apps/host",      "run", "dev"] },
  { label: "web  ", cmd: "npm", args: ["--workspace", "apps/web",       "run", "dev"] },
];

// ─── spawn each process ───────────────────────────────────────────────────────
const children = processes.map(({ label, cmd, args }, i) => {
  const color = COLORS[i % COLORS.length];
  const pre   = prefix(label, color);
  const cwd   = process.cwd();

  const child = spawn(cmd, args, {
    cwd,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  // Stream stdout line-by-line
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => process.stdout.write(pre + line + "\n"));

  // Stream stderr line-by-line
  const rle = createInterface({ input: child.stderr });
  rle.on("line", (line) => process.stderr.write(pre + line + "\n"));

  child.on("exit", (code, signal) => {
    const reason = signal ?? `exit ${code}`;
    process.stderr.write(`${pre}${BOLD}\x1b[31mprocess exited (${reason})${RESET}\n`);
  });

  return child;
});

// ─── clean shutdown ───────────────────────────────────────────────────────────
function shutdown(signal) {
  process.stdout.write(`\n${BOLD}\x1b[90m[dev] ${signal} — stopping all processes…${RESET}\n`);
  children.forEach((c) => {
    try { c.kill(signal); } catch { /* already gone */ }
  });
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.stdout.write(
  `${BOLD}\x1b[90m[dev] starting relay + host + web…${RESET}\n\n`
);
