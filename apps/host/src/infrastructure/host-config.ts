import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persistent host-agent settings that shouldn't live on the command line
 * forever. Currently only `relayUrl` — the WebSocket URL the agent registers
 * with on boot. Setting it once (via `npm run host -- --relay <url>` or by
 * editing this file directly) survives restarts, so users never have to
 * remember the relay address after first setup.
 *
 * Stored next to device.json, in:
 *   Windows : %APPDATA%\remote-control\config.json
 *   macOS/Linux : $XDG_CONFIG_HOME/remote-control/config.json (fallback ~/.config/…)
 */
export interface HostConfig {
  relayUrl?: string;
}

function configDir(): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "remote-control");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "remote-control");
}

function configFile(): string {
  return join(configDir(), "config.json");
}

/** Load settings from disk. Never throws — a missing or corrupt file yields `{}`. */
export function loadHostConfig(): HostConfig {
  const file = configFile();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HostConfig>;
    const out: HostConfig = {};
    if (typeof parsed.relayUrl === "string" && parsed.relayUrl.length > 0) {
      out.relayUrl = parsed.relayUrl;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write settings to disk, creating the directory on first use. */
export function saveHostConfig(config: HostConfig): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Merge new values on top of whatever's there and persist. */
export function updateHostConfig(patch: HostConfig): HostConfig {
  const merged = { ...loadHostConfig(), ...patch };
  saveHostConfig(merged);
  return merged;
}
