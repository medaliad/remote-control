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
  /**
   * Pre-allocated audio transceiver. Its m-line is part of the initial
   * offer/answer (we add it synchronously after `new SimplePeer` but before
   * `simple-peer`'s queued initial `negotiate()` microtask fires), so
   * toggling the mic only swaps the track on this sender - no SDP
   * renegotiation, and no risk of `simple-peer` destroying the peer because
   * an ICE check lost during renegotiation.
   */
  private readonly micTransceiver: RTCRtpTransceiver | null;
  /**
   * The remote stream that will eventually carry the peer's mic audio. We
   * synthesize it from the receiver track up front so we can hand it to the
   * UI immediately, even though no audio is flowing through it yet.
   */
  private readonly remoteMicStream: MediaStream | null;
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
    const internal = this.peer as unknown as { _pc?: RTCPeerConnection };
    const pc = internal._pc ?? null;
    let micTransceiver: RTCRtpTransceiver | null = null;
    let remoteMicStream: MediaStream | null = null;
    if (pc) {
      try {
        micTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
        remoteMicStream = new MediaStream([micTransceiver.receiver.track]);
      } catch (err) {
        console.warn("[peer] addTransceiver(audio) failed:", err);
        micTransceiver = null;
        remoteMicStream = null;
      }
    }
    this.micTransceiver = micTransceiver;
    this.remoteMicStream = remoteMicStream;
    // Re-deliver the remote mic stream when its receiver track unmutes, so
    // the UI can re-call play(). Without this, some Chromium versions pause
    // the <audio> element while the track is producing silence and never
    // resume when RTP starts flowing - making the peer's mic toggle look
    // like a no-op on the listener side.
    if (micTransceiver && remoteMicStream) {
      const remoteMic = remoteMicStream;
      const remoteTrack = micTransceiver.receiver.track;
      remoteTrack.addEventListener("unmute", () => {
        if (this.destroyed) return;
        handlers.onRemoteAudioStream?.(remoteMic);
      });
    }
    let remoteMicDelivered = false;
    const deliverRemoteMic = (): void => {
      if (remoteMicDelivered || !this.remoteMicStream) return;
      remoteMicDelivered = true;
      handlers.onRemoteAudioStream?.(this.remoteMicStream);
    };
    this.peer.on("signal", data => {
      if (this.destroyed) return;
      signaling.send({ type: "signal", data });
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
      deliverRemoteMic();
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
    // Strip any audio track from the screen-share stream before adding it.
    // The pre-allocated audio transceiver is reserved for the microphone;
    // if we let simple-peer.addStream hand the screen audio to addTrack,
    // the browser will reuse the mic transceiver for it (per the WebRTC
    // spec, addTrack picks any compatible transceiver whose sender has no
    // track yet). That hijacks the voice channel: replaceTrack on openMic
    // then overwrites the screen audio, and openMic/closeMic race with the
    // screen audio on the same sender. Voice can stop reaching the peer.
    // The mic uses its own transceiver and works in both directions; if you
    // want to forward system audio later, route it through a separate
    // pre-allocated transceiver, not via addStream.
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      const videoOnly = new MediaStream(stream.getVideoTracks());
      this.peer.addStream(videoOnly);
    } else {
      this.peer.addStream(stream);
    }
  }
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
    if (this.micTransceiver) {
      try {
        await this.micTransceiver.sender.replaceTrack(track);
      } catch (err) {
        console.error("[peer] openMic replaceTrack:", err);
        try { track.stop(); } catch {}
        stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        this.micStream = null;
        this.micTrack = null;
        return false;
      }
      return true;
    }
    try {
      this.peer.addTrack(track, stream);
    } catch (err) {
      console.error("[peer] openMic addTrack:", err);
      try { track.stop(); } catch {}
      stream.getTracks().forEach(t => t.stop());
      this.micStream = null;
      this.micTrack = null;
      return false;
    }
    return true;
  }
  closeMic(): void {
    const track = this.micTrack;
    const stream = this.micStream;
    this.micTrack = null;
    this.micStream = null;
    if (!this.destroyed) {
      if (this.micTransceiver) {
        this.micTransceiver.sender.replaceTrack(null).catch(err => {
          console.warn("[peer] closeMic replaceTrack(null):", err);
        });
      } else if (track && stream) {
        try {
          this.peer.removeTrack(track, stream);
        } catch (err) {
          console.warn("[peer] closeMic removeTrack:", err);
        }
      }
    }
    if (track) {
      try { track.stop(); } catch {}
    }
    if (stream) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    }
  }
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
      try { track.stop(); } catch {}
    }
    if (stream) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    }
    try { this.peer.destroy(); } catch {}
  }
}
