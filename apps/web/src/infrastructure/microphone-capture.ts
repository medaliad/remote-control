import { AUDIO_SAMPLE_RATE } from "@rc/protocol";

/**
 * Captures the browser microphone and emits raw s16le PCM chunks
 * at AUDIO_SAMPLE_RATE (16 kHz mono) — the same format the host expects.
 *
 * Usage:
 *   const mic = new MicrophoneCapture();
 *   await mic.start((pcm) => transport.sendMic(pcm));
 *   mic.stop();
 */
export class MicrophoneCapture {
  private ctx:       AudioContext | null = null;
  private source:    MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream:    MediaStream | null = null;

  async start(onChunk: (pcm: Uint8Array) => void): Promise<void> {
    if (this.ctx) return; // already running

    // navigator.mediaDevices is only available on secure contexts (HTTPS or localhost).
    // On plain HTTP over a local IP the browser blocks it entirely.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicUnavailableError(
        window.location.protocol === "http:" && window.location.hostname !== "localhost"
          ? "insecure-context"
          : "not-supported",
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:     1,
        sampleRate:       AUDIO_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
        video: false,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        throw new MicUnavailableError("permission-denied");
      }
      throw err;
    }

    // Use the browser's native rate; resample via AudioContext if needed.
    this.ctx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });

    this.source    = this.ctx.createMediaStreamSource(this.stream);
    // 1024-sample buffer, 1 input channel, 1 output channel.
    this.processor = this.ctx.createScriptProcessor(1024, 1, 1);

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const floats = e.inputBuffer.getChannelData(0); // Float32Array
      onChunk(float32ToS16le(floats));
    };

    // Must connect to destination for onaudioprocess to fire (browser quirk).
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }

  stop(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.processor = null;
    this.source    = null;
    this.stream    = null;
    this.ctx       = null;
  }
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export type MicUnavailableReason = "insecure-context" | "not-supported" | "permission-denied";

export class MicUnavailableError extends Error {
  constructor(public readonly reason: MicUnavailableReason) {
    super(reason);
    this.name = "MicUnavailableError";
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a Float32 PCM buffer to signed 16-bit little-endian bytes. */
function float32ToS16le(input: Float32Array): Uint8Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i]  = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}
