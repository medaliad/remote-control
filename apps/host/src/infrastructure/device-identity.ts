import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Stable identity for this host machine, persisted across restarts.
 * Mirrors Chrome Remote Desktop: the PIN rotates every run, but the
 * `deviceId` and `deviceName` stay the same so controllers can recognize
 * the machine in their device list.
 */
export interface DeviceIdentity {
  deviceId:   string;
  deviceName: string;
}

/** `%APPDATA%/remote-control` on Windows, `~/.config/remote-control` elsewhere. */
function configDir(): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "remote-control");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "remote-control");
}

function identityFile(): string {
  return join(configDir(), "device.json");
}

/**
 * Load the device identity, creating and persisting a new one on first run.
 * `deviceName` can be overridden via the `DEVICE_NAME` env var.
 */
export function loadOrCreateDeviceIdentity(): DeviceIdentity {
  const file = identityFile();
  const envName = process.env.DEVICE_NAME?.trim();

  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DeviceIdentity>;
      if (parsed.deviceId && parsed.deviceName) {
        // Env var wins for the display name but we do not rewrite the file —
        // lets users temporarily relabel without losing their stored ID.
        return { deviceId: parsed.deviceId, deviceName: envName || parsed.deviceName };
      }
    } catch {
      // Fall through and regenerate.
    }
  }

  const identity: DeviceIdentity = {
    deviceId:   randomUUID(),
    deviceName: envName || hostname(),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(identity, null, 2) + "\n", "utf8");
  return identity;
}

/** Random 6-digit PIN, formatted as `NNN-NNN`. Fresh on every host run. */
export function generatePin(): string {
  const n = String(Math.floor(Math.random() * 900_000) + 100_000);
  return `${n.slice(0, 3)}-${n.slice(3)}`;
}
