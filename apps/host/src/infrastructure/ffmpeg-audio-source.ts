import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import { AUDIO_CHANNELS, AUDIO_CHUNK_BYTES, AUDIO_SAMPLE_RATE } from "@rc/protocol";
import type { AudioSourcePort } from "@/domain/ports";

// Captures system audio via FFmpeg and emits fixed-size raw s16le PCM chunks
// (20ms @ 16kHz mono).
//
// Platform defaults:
//   win32:  -f dshow, device auto-detected (Stereo Mix or similar loopback)
//           Enable "Stereo Mix" in Windows: Sound Settings → Recording → right-click → Show Disabled
//   darwin: -f avfoundation -i ":0"
//   linux:  -f pulse -i default
//
// Override via AUDIO_INPUT env var.

export class FfmpegAudioSource implements AudioSourcePort {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private buf: Buffer = Buffer.alloc(0);

  async start(onChunk: (pcm: Buffer) => void): Promise<void> {
    if (this.proc) return;

    const bin  = ffmpegPath ?? "ffmpeg";
    const args = await buildArgs(bin);

    if (!args) return; // device not found, error already logged

    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc  = proc;

    proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      while (this.buf.length >= AUDIO_CHUNK_BYTES) {
        onChunk(Buffer.from(this.buf.subarray(0, AUDIO_CHUNK_BYTES)));
        this.buf = this.buf.subarray(AUDIO_CHUNK_BYTES);
      }
    });

    proc.stderr.on("data", (c: Buffer) => {
      const line = c.toString("utf8").trim();
      if (line) process.stderr.write(`[ffmpeg-audio] ${line}\n`);
    });

    proc.on("exit", (code) => {
      console.log(`[ffmpeg-audio] exited with code ${code}`);
      this.proc = null;
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
    this.buf  = Buffer.alloc(0);
  }
}

// ─── Arg builders ─────────────────────────────────────────────────────────────

async function buildArgs(bin: string): Promise<string[] | null> {
  const input = await resolveInput(bin);
  if (!input) return null;

  return [
    "-hide_banner",
    "-loglevel", "error",
    ...input,
    "-ac", String(AUDIO_CHANNELS),
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-f",  "s16le",
    "pipe:1",
  ];
}

async function resolveInput(bin: string): Promise<string[] | null> {
  // Manual override always wins.
  if (process.env.AUDIO_INPUT) {
    return platformInputArgs(process.env.AUDIO_INPUT);
  }

  if (process.platform === "win32") {
    return resolveWindowsInput(bin);
  }

  if (process.platform === "darwin") {
    return ["-f", "avfoundation", "-i", ":0"];
  }

  return ["-f", "pulse", "-i", "default"];
}

function platformInputArgs(device: string): string[] {
  if (process.platform === "win32") {
    return ["-f", "dshow", "-i", `audio=${device}`];
  }
  if (process.platform === "darwin") {
    return ["-f", "avfoundation", "-i", device];
  }
  return ["-f", "pulse", "-i", device];
}

// ─── Windows: auto-detect a loopback/stereo-mix dshow device ─────────────────

/**
 * Enumerates DirectShow audio devices and returns args for the best candidate
 * for system-audio capture (Stereo Mix or any device with "mix"/"loopback").
 *
 * If nothing is found it prints actionable instructions and returns null.
 */
async function resolveWindowsInput(bin: string): Promise<string[] | null> {
  const devices = await listDshowAudioDevices(bin);

  // ── 1. Prefer a loopback/stereo-mix device (captures system audio) ────────
  const loopbackKeywords = [
    "stereo mix", "virtual-audio-capturer", "mixage stéréo",
    "estéreo mezclado", "stereomix", "loopback",
    "cable output", "vb-audio", "voicemeeter",
  ];

  const loopback = devices.find((d) =>
    loopbackKeywords.some((kw) => d.toLowerCase().includes(kw)),
  );
  if (loopback) {
    console.log(`[ffmpeg-audio] using loopback device: "${loopback}"`);
    return ["-f", "dshow", "-i", `audio=${loopback}`];
  }

  // ── 2. Fall back to first available device (e.g. microphone) ─────────────
  if (devices.length > 0) {
    const fallback = devices[0]!;
    console.warn(`
[ffmpeg-audio] ⚠  No loopback device found — falling back to: "${fallback}"
[ffmpeg-audio]    This captures microphone input, NOT what plays from your speakers.
[ffmpeg-audio]    To capture system audio, enable "Stereo Mix":
[ffmpeg-audio]      Win+R → mmsys.cpl → Recording tab → right-click → Show Disabled Devices
[ffmpeg-audio]      → enable Stereo Mix → restart npm run dev
`);
    return ["-f", "dshow", "-i", `audio=${fallback}`];
  }

  // ── 3. No devices at all ──────────────────────────────────────────────────
  console.error(`
[ffmpeg-audio] ❌  No audio devices found at all.

  ── How to fix ───────────────────────────────────────────────────────
  Win+R → mmsys.cpl → Recording tab
  → right-click → "Show Disabled Devices" → enable any device
  ─────────────────────────────────────────────────────────────────────
`);
  return null;
}

/**
 * Run `ffmpeg -list_devices` and return all DirectShow audio device names.
 * Works across ffmpeg builds regardless of whether section headers are printed.
 */
function listDshowAudioDevices(bin: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn(
      bin,
      ["-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

    proc.on("exit", () => {
      // Print raw output for debugging.
      process.stderr.write("[ffmpeg-audio] --- device list ---\n" + stderr + "------------------\n");

      const devices: string[] = [];

      for (const raw of stderr.split(/\r?\n/)) {
        const line = raw.trim();

        // Skip alternative-name lines (they contain @device_cm_ or @device_pnp_).
        if (line.includes("@device")) continue;
        // Skip lines that are clearly not device names.
        if (line.includes("Could not") || line.includes("Error")) continue;

        // Match any quoted string — device names on all ffmpeg builds appear in quotes.
        // Also accept lines tagged with "(audio)" to ensure it's an audio device.
        const m = line.match(/"([^"@][^"]*)"/);
        if (!m) continue;

        const name = m[1]!.trim();
        if (!name) continue;

        // Only keep audio devices: either the line contains "(audio)" tag,
        // OR we're in a section that came after the video section (no header builds).
        const isTaggedAudio = line.includes("(audio)");
        const isTaggedVideo = line.includes("(video)");

        if (isTaggedAudio) {
          devices.push(name);
        } else if (!isTaggedVideo) {
          // No tag — include it (older ffmpeg builds don't tag devices).
          devices.push(name);
        }
      }

      resolve([...new Set(devices)]); // deduplicate
    });
  });
}
