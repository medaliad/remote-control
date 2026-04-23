import SimplePeer from "simple-peer";
import type { Signaling } from "./signaling";

/**
 * WebRTC wrapper built on simple-peer — the same library ScreenCat uses.
 *
 * simple-peer collapses SDP + ICE + renegotiation into one opaque `signal`
 * event, which we tunnel through our existing signaling server. It also
 * handles the hairier bits (perfect-negotiation, implicit rollback, trickle
 * ICE, datachannel lifecycle) that we previously hand-rolled in this file.
 *
 * Media flow:
 *   host   → addScreenStream(stream) adds the getDisplayMedia tracks
 *            simple-peer auto-renegotiates so the client receives them
 *   client → initiator=true: creates the data channel and sends the first
 *            offer the moment the Peer is constructed
 *
 * Control flow:
 *   The built-in data channel (ordered) carries JSON input events. The
 *   *host* decides whether to honor them (`allowControl` flag from server).
 */

export type InputEvent =
  | { t: "mouse";    x: number; y: number; button?: number; kind: "move" | "down" | "up" | "click" }
  | { t: "key";      key: string; code: string; kind: "down" | "up" }
  | { t: "wheel";    dx: number; dy: number }
  | { t: "hello";    clientName: string };

export interface PeerHandlers {
  onRemoteStream?: (stream: MediaStream) => void;
  onInput?:        (ev: InputEvent) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onChannelOpen?:  () => void;
  onChannelClose?: () => void;
}

export class Peer {
  private readonly peer: SimplePeer.Instance;
  private destroyed = false;

  constructor(
    signaling: Signaling,
    role: "host" | "client",
    handlers: PeerHandlers,
  ) {
    this.peer = new SimplePeer({
      // Client is the initiator: it creates the data channel and fires
      // the first offer. Host waits for the offer, same as before.
      initiator: role === "client",
      // Trickle ICE — send candidates as they're discovered. Matches what
      // we were doing manually with pc.onicecandidate.
      trickle: true,
      channelName: "input",
      channelConfig: { ordered: true },
      config: {
        // Google STUN covers ~85% of home NATs. If you need symmetric-NAT
        // traversal, add TURN here (coturn, Twilio, Xirsys, etc.).
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      },
    });

    // simple-peer emits a single opaque `signal` payload for SDP, ICE,
    // and renegotiation markers. We tunnel it through our server blindly;
    // the peer on the other end knows how to parse it via peer.signal().
    this.peer.on("signal", (data) => {
      if (this.destroyed) return;
      signaling.send({ type: "signal", data });
    });

    this.peer.on("stream", (stream) => {
      handlers.onRemoteStream?.(stream);
    });

    this.peer.on("connect", () => {
      // "connect" fires when the data channel is open. That's our "channel
      // open" and also implicitly "peer connected".
      handlers.onChannelOpen?.();
      handlers.onConnectionStateChange?.("connected");
    });

    this.peer.on("data", (buf) => {
      try {
        const text = typeof buf === "string" ? buf : new TextDecoder().decode(buf);
        const msg = JSON.parse(text) as InputEvent;
        handlers.onInput?.(msg);
      } catch { /* non-JSON control frame — ignore */ }
    });

    this.peer.on("close", () => {
      if (this.destroyed) return;
      this.destroyed = true;
      handlers.onChannelClose?.();
      handlers.onConnectionStateChange?.("closed");
    });

    this.peer.on("error", (err) => {
      // simple-peer surfaces ICE failures, SDP rejection, and data-channel
      // errors here. We map to "failed" so the caller tears down.
      console.error("[peer] error:", err);
      if (this.destroyed) return;
      handlers.onConnectionStateChange?.("failed");
    });
  }

  /** Host only: add a screen-share stream. Triggers auto-renegotiation. */
  addScreenStream(stream: MediaStream): void {
    if (this.destroyed) return;
    this.peer.addStream(stream);
  }

  /** Send an input event over the data channel. No-op until connected. */
  sendInput(ev: InputEvent): void {
    if (this.destroyed) return;
    // simple-peer's `.connected` turns true after the data channel opens.
    if (!this.peer.connected) return;
    try { this.peer.send(JSON.stringify(ev)); } catch { /* ignore */ }
  }

  /** Handle a signal packet the server relayed from the peer. */
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
    try { this.peer.destroy(); } catch { /* ignore */ }
  }
}
