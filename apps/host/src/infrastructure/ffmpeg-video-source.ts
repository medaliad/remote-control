import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import { DEFAULT_VIDEO, type VideoConfig } from "@rc/protocol";
import type { VideoSourcePort } from "@/domain/ports";
import { JpegSplitter } from "./jpeg-splitter";

export class FfmpegVideoSource implements VideoSourcePort {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;

  constructor(private readonly config: VideoConfig = DEFAULT_VIDEO) {}

  async start(onFrame: (jpeg: Buffer) => void): Promise<void> {
    if (this.proc) return;
    const args = buildArgs(this.config);
    const bin = ffmpegPath ?? "ffmpeg";
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;

    const splitter = new JpegSplitter(onFrame);
    proc.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));
    proc.stderr.on("data", (c: Buffer) => {
      const line = c.toString("utf8").trim();
      if (line) process.stderr.write(`[ffmpeg-video] ${line}\n`);
    });
    proc.on("exit", (code) => {
      console.log(`[ffmpeg-video] exited with code ${code}`);
      this.proc = null;
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
  }
}

function buildArgs(cfg: VideoConfig): string[] {
  const scale = `scale=${cfg.width}:${cfg.height}:force_original_aspect_ratio=decrease,pad=${cfg.width}:${cfg.height}:(ow-iw)/2:(oh-ih)/2`;
  const common = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    String(cfg.fps),
  ];
  const capture =
    process.platform === "win32"
      ? ["-f", "gdigrab", "-i", "desktop"]
      : process.platform === "darwin"
        ? ["-f", "avfoundation", "-i", process.env.VIDEO_INPUT ?? "1"]
        : ["-f", "x11grab", "-i", process.env.VIDEO_INPUT ?? ":0.0"];
  return [
    ...common,
    ...capture,
    "-vf",
    scale,
    "-q:v",
    String(cfg.quality),
    "-f",
    "mjpeg",
    "pipe:1",
  ];
}
