import { networkInterfaces } from "node:os";
import { runHostSession } from "@/application/run-host-session";
import { NutInputInjector } from "@/infrastructure/nut-input-injector";
import { WebSocketTransport } from "@/infrastructure/websocket-transport";
import { FfmpegVideoSource } from "@/infrastructure/ffmpeg-video-source";
import { FfmpegAudioSource } from "@/infrastructure/ffmpeg-audio-source";
import { FfmpegAudioSink } from "@/infrastructure/ffmpeg-audio-sink";
import {
  generatePin,
  loadOrCreateDeviceIdentity,
} from "@/infrastructure/device-identity";
import { startLocalInfoServer } from "@/infrastructure/local-info-server";

// ─── Config ───────────────────────────────────────────────────────────────────

const RELAY_URL  = process.env.RELAY_URL  ?? "ws://localhost:4000";
const WEB_PORT   = process.env.WEB_PORT   ?? "3000";
const LOCAL_PORT = Number(process.env.LOCAL_PORT ?? 4001);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Best non-loopback IPv4 address on this machine. */
function getLanIp(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "localhost";
}

// ─── Big ASCII digits for the PIN banner ──────────────────────────────────────

const GLYPH: Record<string, string[]> = {
  "0": ["▄█▄", "█ █", "█ █", "█ █", "▀█▀"],
  "1": [" ██", "  █", "  █", "  █", "  █"],
  "2": ["▄█▄", "  █", "▄█▀", "█  ", "███"],
  "3": ["▄█▄", "  █", " █▄", "  █", "▀█▀"],
  "4": ["█ █", "█ █", "███", "  █", "  █"],
  "5": ["███", "█  ", "▀█▄", "  █", "▀█▀"],
  "6": ["▄█▄", "█  ", "███", "█ █", "▀█▀"],
  "7": ["███", "  █", " ▄█", " █ ", " █ "],
  "8": ["▄█▄", "█ █", "▄█▄", "█ █", "▀█▀"],
  "9": ["▄█▄", "█ █", "███", "  █", "▀█▀"],
  "-": ["   ", "   ", "▄▄▄", "   ", "   "],
};

function bigText(str: string): string[] {
  const rows: string[][] = Array.from({ length: 5 }, () => []);
  for (const ch of str) {
    const glyph = GLYPH[ch] ?? GLYPH["-"]!;
    for (let r = 0; r < 5; r++) rows[r]!.push(glyph[r]!);
  }
  return rows.map((r) => r.join("  "));
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(deviceName: string, pin: string, relayUrl: string, lanIp: string): void {
  const hostUiUrl = `http://${lanIp}:${WEB_PORT}/host`;
  const pickerUrl = `http://${lanIp}:${WEB_PORT}/`;
  const W = 52;
  const pad = (s: string, w = W) => s + " ".repeat(Math.max(0, w - s.length));
  const hr  = "─".repeat(W + 2);
  const pinRows = bigText(pin);

  const lines = [
    `┌${hr}┐`,
    `│  ${pad(`🖥  Remote Control   ·   ${deviceName}`)}  │`,
    `├${hr}┤`,
    `│  ${pad("")}  │`,
    `│  ${pad("  One-time PIN (changes every restart):")}  │`,
    `│  ${pad("")}  │`,
    ...pinRows.map((row) => {
      const centered = row.padStart(Math.floor((W + row.length) / 2)).padEnd(W);
      return `│  ${centered}  │`;
    }),
    `│  ${pad("")}  │`,
    `├${hr}┤`,
    `│  ${pad("")}  │`,
    `│  ${pad("  ► Open this on the host computer:")}  │`,
    `│  ${pad("    " + hostUiUrl)}  │`,
    `│  ${pad("")}  │`,
    `│  ${pad("  ► Open this on your phone / other device:")}  │`,
    `│  ${pad("    " + pickerUrl)}  │`,
    `│  ${pad("")}  │`,
    `├${hr}┤`,
    `│  ${pad(`  Relay  :  ${relayUrl}`)}  │`,
    `└${hr}┘`,
  ];

  console.log("\n" + lines.join("\n") + "\n");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const identity = loadOrCreateDeviceIdentity();
  const pin      = generatePin();
  const lanIp    = getLanIp();

  printBanner(identity.deviceName, pin, RELAY_URL, lanIp);

  await startLocalInfoServer(LOCAL_PORT, {
    deviceId:   identity.deviceId,
    deviceName: identity.deviceName,
    pin,
  });

  const transport = new WebSocketTransport(RELAY_URL);
  const video     = new FfmpegVideoSource();
  const audio     = new FfmpegAudioSource();
  const audioSink = new FfmpegAudioSink();
  const injector  = new NutInputInjector();

  await runHostSession({
    transport, video, audio, audioSink, injector,
    registration: { deviceId: identity.deviceId, deviceName: identity.deviceName, pin },
  });
}

bootstrap().catch((err) => {
  console.error("[host] fatal", err);
  process.exit(1);
});
