import type { Signaling } from "./signaling";

/**
 * WebRTC wrapper with a tiny "perfect negotiation" pattern.
 *
 * The server pairs the two peers with explicit roles: the client is the
 * `polite` peer (it backs off on collision) and the host is the `impolite`
 * one. This removes the race condition where both sides renegotiate at once.
 *
 * Media flow:
 *   host → captures screen via getDisplayMedia, adds tracks
 *   client → receives ontrack, attaches stream to its <video>
 *
 * Control flow:
 *   A single RTCDataChannel "input" carries JSON events (mouse/key). The
 *   *host* decides whether to honor them (`allowControl` flag from server).
 *   The client opens the channel when polite=true — so the host just waits
 *   for ondatachannel.
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
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;

  constructor(
    private readonly signaling: Signaling,
    private readonly role: "host" | "client",
    private readonly handlers: PeerHandlers,
  ) {
    this.pc = new RTCPeerConnection({
      // Google STUN is fine for the overwhelming majority of networks.
      // Add TURN via env if you need to punch through strict NATs.
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) signaling.send({ type: "signal", data: { kind: "ice", candidate: ev.candidate } });
    };

    this.pc.ontrack = (ev) => {
      // Accumulate tracks into the first stream; this is reliable for our
      // single-stream case (one screen share).
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      handlers.onRemoteStream?.(stream);
    };

    this.pc.onconnectionstatechange = () => {
      handlers.onConnectionStateChange?.(this.pc.connectionState);
    };

    // Perfect negotiation — needed whenever either side can renegotiate
    // (e.g. the host adds a track mid-session).
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        signaling.send({ type: "signal", data: { kind: "sdp", description: this.pc.localDescription } });
      } catch (err) {
        console.error("[peer] negotiation error:", err);
      } finally {
        this.makingOffer = false;
      }
    };

    // Client opens the channel; host receives it.
    if (role === "client") {
      this.channel = this.pc.createDataChannel("input", { ordered: true });
      this.wireChannel(this.channel);
    } else {
      this.pc.ondatachannel = (ev) => {
        this.channel = ev.channel;
        this.wireChannel(this.channel);
      };
    }
  }

  /** Host only: add a screen-share track to the peer connection. */
  addScreenStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
  }

  /** Client only: send an input event (only really used when host allows it). */
  sendInput(ev: InputEvent): void {
    if (!this.channel || this.channel.readyState !== "open") return;
    this.channel.send(JSON.stringify(ev));
  }

  /** Handle a signal packet the signaling server relayed from the peer. */
  async handleRemoteSignal(data: unknown): Promise<void> {
    if (!data || typeof data !== "object") return;
    const d = data as { kind: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

    try {
      if (d.kind === "sdp" && d.description) {
        const polite = this.role === "client";
        const offerCollision =
          d.description.type === "offer" &&
          (this.makingOffer || this.pc.signalingState !== "stable");

        this.ignoreOffer = !polite && offerCollision;
        if (this.ignoreOffer) return;

        await this.pc.setRemoteDescription(d.description);
        if (d.description.type === "offer") {
          await this.pc.setLocalDescription();
          this.signaling.send({
            type: "signal",
            data: { kind: "sdp", description: this.pc.localDescription },
          });
        }
      } else if (d.kind === "ice" && d.candidate) {
        try { await this.pc.addIceCandidate(d.candidate); }
        catch (err) { if (!this.ignoreOffer) console.warn("[peer] addIceCandidate:", err); }
      }
    } catch (err) {
      console.error("[peer] handleRemoteSignal:", err);
    }
  }

  close(): void {
    try { this.channel?.close(); } catch { /* ignore */ }
    try { this.pc.close(); }     catch { /* ignore */ }
  }

  private wireChannel(ch: RTCDataChannel): void {
    ch.onopen  = () => this.handlers.onChannelOpen?.();
    ch.onclose = () => this.handlers.onChannelClose?.();
    ch.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as InputEvent;
        this.handlers.onInput?.(msg);
      } catch { /* non-JSON control frame — ignore */ }
    };
  }
}
