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
import { loadHostConfig } from "@/infrastructure/host-config";
import { startLocalInfoServer } from "@/infrastructure/local-info-server";
import type { HostRegistration } from "@/domain/ports";

// ─── Config ───────────────────────────────────────────────────────────────────
// Precedence, highest wins:
//   1. RELAY_URL env var           (one-off: `RELAY_URL=… npm run host`)
//   2. config.json persisted value (set via `rc-host --relay …` or by hand)
//   3. built-in default            (ws://localhost:4000, dev-only)

const persisted    = loadHostConfig();
const RELAY_URL    = process.env.RELAY_URL ?? persisted.relayUrl ?? "ws://localhost:4000";
const RELAY_SOURCE =
  process.env.RELAY_URL  ? "env"
  : persisted.relayUrl   ? "config.json"
  :                        "default (localhost)";
const WEB_PORT     = process.env.WEB_PORT   ?? "3000";
const LOCAL_PORT   = Number(process.env.LOCAL_PORT ?? 4001);

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function printBanner(deviceName: string, pin: string, relayUrl: string, relaySource: string, lanIp: string): void {
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
    `│  ${pad(`  Source :  ${relaySource}`)}  │`,
    `└${hr}┘`,
  ];

  console.log("\n" + lines.join("\n") + "\n");
}

// ─── Reconnect loop ───────────────────────────────────────────────────────────
// Runs forever. Keeps the host registered with the relay even when the socket
// dies — essential behind Render/Fly/Cloudflare which reap idle WebSockets.

async function runWithReconnect(registration: HostRegistration): Promise<never> {
  const video     = new FfmpegVideoSource();
  const audio     = new FfmpegAudioSource();
  const audioSink = new FfmpegAudioSink();
  const injector  = new NutInputInjector();

  let backoffMs = 1_000;
  const MAX_BACKOFF_MS = 30_000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const transport = new WebSocketTransport(RELAY_URL);

    // Promise that resolves the moment the socket closes after a successful connect.
    let reportClose!: (info: { code: number; reason: string }) => void;
    const closedPromise = new Promise<{ code: number; reason: string }>((resolve) => {
      reportClose = resolve;
    });
    transport.onClose((info) => reportClose(info));

    try {
      await runHostSession({ transport, video, audio, audioSink, injector, registration });
      console.log(`[host] registered with relay (${RELAY_URL})`);
      backoffMs = 1_000;                // successful connect — reset backoff

      const info = await closedPromise; // now just wait for the socket to die
      console.warn(`[host] connection closed (code=${info.code}${info.reason ? `, reason=${info.reason}` : ""}) — reconnecting`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[host] connect failed: ${msg}`);
      try { transport.close(); } catch { /* ignore */ }

      // "device already online" is permanent: another agent has this deviceId.
      // Retrying would just fight it. Exit so a service manager / user notices.
      if (/device already online/i.test(msg)) {
        console.error("[host] another agent is already registered as this device — exiting");
        process.exit(2);
      }
    }

    // Drop any in-flight capture — we no longer have a peer to send to.
    await video.stop().catch(() => { /* ignore */ });
    await audio.stop().catch(() => { /* ignore */ });
    audioSink.stop();

    const wait = Math.min(backoffMs, MAX_BACKOFF_MS);
    console.log(`[host] reconnecting in ${Math.round(wait / 1000)}s…`);
    await new Promise((r) => setTimeout(r, wait));
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const identity = loadOrCreateDeviceIdentity();
  const pin      = generatePin();
  const lanIp    = getLanIp();

  printBanner(identity.deviceName, pin, RELAY_URL, RELAY_SOURCE, lanIp);

  await startLocalInfoServer(LOCAL_PORT, {
    deviceId:   identity.deviceId,
    deviceName: identity.deviceName,
    pin,
    relayUrl:   RELAY_URL,
  });

  await runWithReconnect({ deviceId: identity.deviceId, deviceName: identity.deviceName, pin });
}

bootstrap().catch((err) => {
  console.error("[host] fatal", err);
  process.exit(1);
});
