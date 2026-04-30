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
  onInput?: (ev: InputEvent) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onChannelOpen?: () => void;
  onChannelClose?: () => void;
}
export class Peer {
  private readonly peer: SimplePeer.Instance;
  private destroyed = false;
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
      handlers.onRemoteStream?.(stream);
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
    try {
      this.peer.destroy();
    } catch {}
  }
}
