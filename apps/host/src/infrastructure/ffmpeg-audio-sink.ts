import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE } from "@rc/protocol";
import type { AudioSinkPort } from "@/domain/ports";

/**
 * Plays raw s16le PCM received from the controller's microphone through the
 * host machine's default speakers by piping into an ffmpeg process.
 *
 * Platform selection order:
 *   win32  → wasapi (auto-detected device) → sdl2 fallback
 *   linux  → pulse:default → alsa:default fallback
 *   darwin → coreaudio
 *
 * Override with SPEAKER_OUTPUT env var, e.g.:
 *   SPEAKER_OUTPUT=none                 disable mic-to-speaker entirely
 *   SPEAKER_OUTPUT=wasapi:Speakers      exact device friendly name
 *   SPEAKER_OUTPUT=pulse:default
 */
export class FfmpegAudioSink implements AudioSinkPort {
  private proc:    ChildProcessByStdio<Writable, null, Readable> | null = null;
  private dead     = false;
  private starting = false;
  /** Queue of chunks that arrived before the process was ready. */
  private pending: Buffer[] = [];

  /** Called when first mic chunk arrives OR when a new session begins. */
  write(pcm: Buffer): void {
    if (this.dead) return;

    if (this.proc) {
      // Process already up — pipe directly.
      if (this.proc.stdin.writable) this.proc.stdin.write(pcm);
      return;
    }

    // Buffer this chunk and kick off (async) startup.
    this.pending.push(pcm);
    if (!this.starting) void this.start();
  }

  stop(): void {
    this.dead     = false; // allow fresh start next session
    this.starting = false;
    this.pending  = [];
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    this.proc.kill("SIGTERM");
    this.proc = null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    this.starting = true;

    const override = process.env.SPEAKER_OUTPUT;
    if (override === "none") {
      console.log("[ffmpeg-sink] disabled via SPEAKER_OUTPUT=none");
      this.dead = true;
      return;
    }

    const output = override ?? await detectOutput();
    console.log(`[ffmpeg-sink] starting  output=${output}`);

    const bin  = ffmpegPath ?? "ffmpeg";
    const args = buildArgs(output);

    const proc = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
    this.proc     = proc;
    this.starting = false;

    // Drain any chunks that arrived during startup.
    for (const chunk of this.pending) {
      if (proc.stdin.writable) proc.stdin.write(chunk);
    }
    this.pending = [];

    // Collect stderr to display on failure.
    const stderrLines: string[] = [];
    proc.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) stderrLines.push(line.trim());
      }
    });

    proc.on("exit", (code) => {
      this.proc = null;
      if (code !== 0) {
        for (const l of stderrLines) process.stderr.write(`[ffmpeg-sink] ${l}\n`);
        console.error(
          `[ffmpeg-sink] process exited (code ${code}) with output="${output}". ` +
          `Set SPEAKER_OUTPUT=none to disable, or SPEAKER_OUTPUT=<format>:<device> to override.`,
        );
        this.dead = true;
      }
    });

    proc.on("error", (err) => {
      console.error("[ffmpeg-sink] spawn error:", err.message);
      this.proc = null;
      this.dead = true;
    });
  }
}

// ─── Output detection ─────────────────────────────────────────────────────────

async function detectOutput(): Promise<string> {
  switch (process.platform) {
    case "darwin": return "coreaudio";
    case "win32":  return detectWindowsOutput();
    default:       return "pulse:default";
  }
}

/**
 * On Windows, try to enumerate WASAPI devices and use the first playback device.
 * Falls back to sdl2 if wasapi enumeration fails.
 */
async function detectWindowsOutput(): Promise<string> {
  const device = await listWasapiDevices();
  if (device) {
    console.log(`[ffmpeg-sink] detected WASAPI device: "${device}"`);
    return `wasapi:${device}`;
  }
  // SDL2 fallback — works if the SDL2 build supports audio.
  console.log("[ffmpeg-sink] WASAPI enumeration failed, falling back to sdl2");
  return "sdl2:RC Audio";
}

/**
 * Run `ffmpeg -list_devices true -f wasapi -i dummy` and parse the first
 * output device name from stderr.  ffmpeg exits non-zero here — that's normal.
 */
function listWasapiDevices(): Promise<string> {
  return new Promise((resolve) => {
    const bin = ffmpegPath ?? "ffmpeg";
    const proc = spawn(
      bin,
      ["-hide_banner", "-list_devices", "true", "-f", "wasapi", "-i", "dummy"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("exit",  () => resolve(parseWasapiDevice(stderr)));
    proc.on("error", () => resolve(""));
  });
}

/**
 * Parse lines like:   "Speakers (Realtek Audio)" (id={...})
 * ffmpeg lists output devices after "DirectShow audio devices" or simply lists them.
 * We want the first device that appears to be an output (Speakers, Headphones, etc.).
 */
function parseWasapiDevice(stderr: string): string {
  for (const line of stderr.split(/\r?\n/)) {
    const m = /"([^"]+)"\s*\(id=/.exec(line);
    if (m) return m[1]!;
  }
  return "";
}

// ─── ffmpeg args ──────────────────────────────────────────────────────────────

function buildArgs(output: string): string[] {
  const colonIdx  = output.indexOf(":");
  const outFormat = colonIdx === -1 ? output : output.slice(0, colonIdx);
  const outDevice = colonIdx === -1 ? ""     : output.slice(colonIdx + 1);

  const args: string[] = [
    "-hide_banner",
    "-loglevel", "error",
    "-f",  "s16le",
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-ac", String(AUDIO_CHANNELS),
    "-i",  "pipe:0",
    "-f",  outFormat,
  ];

  if (outDevice) args.push(outDevice);

  return args;
}
