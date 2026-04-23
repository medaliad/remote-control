import { AUDIO_SAMPLE_RATE } from "@rc/protocol";
import type { AudioPlayerPort } from "@/domain/ports";

// Streams s16le PCM chunks by scheduling AudioBufferSourceNodes back-to-back.
// Each enqueued chunk is converted to Float32, wrapped in an AudioBuffer, and
// scheduled at the tail of the previous chunk so playback remains continuous.
export class WebAudioPlayer implements AudioPlayerPort {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    this.nextTime = this.ctx.currentTime;

    if (this.ctx.state === "suspended") {
      // Browsers block AudioContext.resume() until a user gesture has occurred.
      // When the phone opens a share link and auto-connects (via setTimeout there
      // is no gesture context), the context stays suspended and audio is silent.
      // Fix: attempt resume now (works if a gesture already happened), AND attach
      // one-time listeners so the context resumes on the very next tap/click/key.
      void this.ctx.resume().catch(() => {});
      this.attachGestureResumeListeners();
    }
  }

  /** Called from any user-interaction handler to force the context awake. */
  resumeIfSuspended(): void {
    if (this.ctx?.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
  }

  private attachGestureResumeListeners(): void {
    const resume = () => {
      this.resumeIfSuspended();
      document.removeEventListener("click",      resume);
      document.removeEventListener("touchstart", resume);
      document.removeEventListener("keydown",    resume);
    };
    document.addEventListener("click",      resume, { once: true, capture: true });
    document.addEventListener("touchstart", resume, { once: true, capture: true });
    document.addEventListener("keydown",    resume, { once: true, capture: true });
  }

  enqueue(pcm: Uint8Array): void {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;

    // If the context is still suspended (no gesture yet), try once more and
    // silently drop this frame — it'll catch up once audio is unblocked.
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
      return;
    }

    const floats = s16leToFloat32(pcm);
    const buffer = ctx.createBuffer(1, floats.length, ctx.sampleRate);
    buffer.copyToChannel(floats as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(this.nextTime, ctx.currentTime);
    src.start(startAt);
    this.nextTime = startAt + buffer.duration;
  }

  stop(): void {
    this.ctx?.close();
    this.ctx = null;
    this.nextTime = 0;
  }
}

function s16leToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const s = view.getInt16(i * 2, true);
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}
