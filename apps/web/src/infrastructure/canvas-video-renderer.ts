import type { VideoRendererPort } from "@/domain/ports";

export class CanvasVideoRenderer implements VideoRendererPort {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private pendingUrl: string | null = null;

  // ─── FPS tracking ──────────────────────────────────────────────────────────
  private fpsCallback?: (fps: number) => void;
  private frameCount = 0;
  private fpsTimer = 0;

  /** Register a callback that fires with the current FPS once per second. */
  onFps(cb: (fps: number) => void): void {
    this.fpsCallback = cb;
    this.startFpsTimer();
  }

  private startFpsTimer(): void {
    this.stopFpsTimer();
    this.frameCount = 0;
    this.fpsTimer = window.setInterval(() => {
      this.fpsCallback?.(this.frameCount);
      this.frameCount = 0;
    }, 1000);
  }

  private stopFpsTimer(): void {
    if (this.fpsTimer) {
      clearInterval(this.fpsTimer);
      this.fpsTimer = 0;
    }
  }

  // ─── VideoRendererPort ─────────────────────────────────────────────────────
  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  render(jpeg: Uint8Array): void {
    if (!this.ctx || !this.canvas) return;

    // Copy into a guaranteed plain ArrayBuffer so Blob accepts it regardless of ArrayBufferLike.
    const raw = new Uint8Array(jpeg.byteLength);
    raw.set(jpeg);
    const blob = new Blob([raw.buffer as ArrayBuffer], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      if (!this.ctx || !this.canvas) {
        URL.revokeObjectURL(url);
        return;
      }
      if (this.canvas.width !== img.width || this.canvas.height !== img.height) {
        this.canvas.width = img.width;
        this.canvas.height = img.height;
      }
      this.ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      this.frameCount++;
    };

    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    this.pendingUrl = url;
  }

  detach(): void {
    this.stopFpsTimer();
    if (this.pendingUrl) URL.revokeObjectURL(this.pendingUrl);
    this.pendingUrl = null;
    this.canvas = null;
    this.ctx = null;
  }
}
