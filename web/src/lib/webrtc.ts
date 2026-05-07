import SimplePeer from "simple-peer";
import type { Signaling } from "./signaling";
export type InputEvent = {
  t: "mouse";
  x: number;
  y: number;
  button?: number;
  kind: "move" | "down" | "up" | "click";
} | {
  t: "key";
  key: string;
  code: string;
  kind: "down" | "up";
} | {
  t: "wheel";
  dx: number;
  dy: number;
} | {
  t: "hello";
  clientName: string;
};
export interface PeerHandlers {
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteAudioStream?: (stream: MediaStream) => void;
  onInput?: (ev: InputEvent) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onChannelOpen?: () => void;
  onChannelClose?: () => void;
}
export class Peer {
  private readonly peer: SimplePeer.Instance;
  private destroyed = false;
  private micStream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  constructor(signaling: Signaling, role: "host" | "client", handlers: PeerHandlers) {
    this.peer = new SimplePeer({
      initiator: role === "client",
      trickle: true,
      channelName: "input",
      channelConfig: {
        ordered: true
      },
      config: {
        iceServers: [{
          urls: "stun:stun.l.google.com:19302"
        }]
      }
    });
    this.peer.on("signal", data => {
      if (this.destroyed) return;
      signaling.send({
        type: "signal",
        data
      });
    });
    this.peer.on("stream", stream => {
      const hasVideo = stream.getVideoTracks().length > 0;
      const hasAudio = stream.getAudioTracks().length > 0;
      if (hasVideo) {
        handlers.onRemoteStream?.(stream);
      } else if (hasAudio) {
        handlers.onRemoteAudioStream?.(stream);
      } else {
        handlers.onRemoteStream?.(stream);
      }
    });
    this.peer.on("connect", () => {
      handlers.onChannelOpen?.();
      handlers.onConnectionStateChange?.("connected");
    });
    this.peer.on("data", buf => {
      try {
        const text = typeof buf === "string" ? buf : new TextDecoder().decode(buf);
        const msg = JSON.parse(text) as InputEvent;
        handlers.onInput?.(msg);
      } catch {}
    });
    this.peer.on("close", () => {
      if (this.destroyed) return;
      this.destroyed = true;
      handlers.onChannelClose?.();
      handlers.onConnectionStateChange?.("closed");
    });
    this.peer.on("error", err => {
      console.error("[peer] error:", err);
      if (this.destroyed) return;
      handlers.onConnectionStateChange?.("failed");
    });
  }
  addScreenStream(stream: MediaStream): void {
    if (this.destroyed) return;
    this.peer.addStream(stream);
  }
  /**
   * Acquire the microphone and start sending audio to the peer.
   * Returns true on success. If the mic is already open, this is a no-op
   * (and ensures the track is enabled).
   */
  async openMic(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.micTrack) {
      this.micTrack.enabled = true;
      return true;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (err) {
      console.error("[peer] openMic getUserMedia:", err);
      return false;
    }
    if (this.destroyed) {
      stream.getTracks().forEach(t => t.stop());
      return false;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach(t => t.stop());
      return false;
    }
    this.micStream = stream;
    this.micTrack = track;
    track.enabled = true;
    try {
      this.peer.addTrack(track, stream);
    } catch (err) {
      console.error("[peer] openMic addTrack:", err);
      try {
        track.stop();
      } catch {}
      stream.getTracks().forEach(t => t.stop());
      this.micStream = null;
      this.micTrack = null;
      return false;
    }
    return true;
  }
  /**
   * Stop sending mic audio and release the device.
   */
  closeMic(): void {
    const track = this.micTrack;
    const stream = this.micStream;
    this.micTrack = null;
    this.micStream = null;
    if (track && stream && !this.destroyed) {
      try {
        this.peer.removeTrack(track, stream);
      } catch (err) {
        console.warn("[peer] closeMic removeTrack:", err);
      }
    }
    if (track) {
      try {
        track.stop();
      } catch {}
    }
    if (stream) {
      stream.getTracks().forEach(t => {
        try {
          t.stop();
        } catch {}
      });
    }
  }
  /**
   * Whether the mic is currently open (track acquired and being sent).
   */
  isMicOpen(): boolean {
    return this.micTrack !== null;
  }
  sendInput(ev: InputEvent): void {
    if (this.destroyed) return;
    if (!this.peer.connected) return;
    try {
      this.peer.send(JSON.stringify(ev));
    } catch {}
  }
  async handleRemoteSignal(data: unknown): Promise<void> {
    if (this.destroyed || !data) return;
    try {
      this.peer.signal(data as SimplePeer.SignalData);
    } catch (err) {
      console.error("[peer] handleRemoteSignal:", err);
    }
  }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const track = this.micTrack;
    const stream = this.micStream;
    this.micTrack = null;
    this.micStream = null;
    if (track) {
      try {
        track.stop();
      } catch {}
    }
    if (stream) {
      stream.getTracks().forEach(t => {
        try {
          t.stop();
        } catch {}
      });
    }
    try {
      this.peer.destroy();
    } catch {}
  }
}
