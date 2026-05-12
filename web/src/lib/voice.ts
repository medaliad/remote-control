import { Room, RoomEvent, Track, type RemoteTrack, type RemoteParticipant, type LocalAudioTrack, createLocalAudioTrack } from "livekit-client";

/**
 * Voice over LiveKit.
 *
 * Shape mirrors the mic-related methods that used to live on `Peer` in
 * webrtc.ts, so Host.tsx / Client.tsx only swap the method receiver:
 *
 *   await voice.open(sessionCode, role);  // joins the room
 *   await voice.openMic();                // publishes mic
 *   voice.closeMic();                     // unpublishes mic
 *   voice.close();                        // leaves the room
 *
 * Remote audio tracks are attached to a hidden <audio> element via the
 * `onRemoteAudioStream` callback, exactly like the previous mic path did.
 * If the server doesn't have LIVEKIT_* env vars set, `open()` resolves to
 * `false` and the UI shows the mic feature as unavailable.
 */
export interface VoiceHandlers {
  onRemoteAudioStream?: (stream: MediaStream) => void;
  onMicStateChange?: (open: boolean) => void;
}

interface TokenResponse {
  ok: boolean;
  token?: string;
  url?: string;
  room?: string;
  identity?: string;
  error?: string;
}

async function fetchToken(sessionCode: string, role: "host" | "client", displayName: string): Promise<TokenResponse> {
  const res = await fetch("/api/livekit/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionCode, role, displayName }),
  });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch {}
    return { ok: false, error: (body as { error?: string } | null)?.error ?? `http-${res.status}` };
  }
  return res.json() as Promise<TokenResponse>;
}

export class Voice {
  private room: Room | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private destroyed = false;
  private readonly handlers: VoiceHandlers;
  /** A single MediaStream that aggregates every remote audio track. */
  private readonly remoteStream = new MediaStream();
  private deliveredOnce = false;

  constructor(handlers: VoiceHandlers) {
    this.handlers = handlers;
  }

  /**
   * Join the LiveKit room for this session. Returns false if voice isn't
   * available (LIVEKIT_* env vars not set on the server, network error,
   * etc.) - the caller should disable the mic button in that case.
   */
  async open(sessionCode: string, role: "host" | "client", displayName: string): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.room) return true;
    const tokenResp = await fetchToken(sessionCode, role, displayName).catch((err) => {
      console.warn("[voice] token fetch failed:", err);
      return { ok: false, error: "fetch-failed" } as TokenResponse;
    });
    if (!tokenResp.ok || !tokenResp.token || !tokenResp.url) {
      console.warn("[voice] LiveKit unavailable:", tokenResp.error);
      return false;
    }
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      // Default audio capture settings - matches the old getUserMedia config.
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, _participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const mediaTrack = track.mediaStreamTrack;
      if (!mediaTrack) return;
      // Add the track to our aggregate stream and re-deliver, so the
      // <audio> element keeps playing all remote participants together.
      if (!this.remoteStream.getTracks().includes(mediaTrack)) {
        this.remoteStream.addTrack(mediaTrack);
      }
      this.deliveredOnce = true;
      this.handlers.onRemoteAudioStream?.(this.remoteStream);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const mediaTrack = track.mediaStreamTrack;
      if (!mediaTrack) return;
      try { this.remoteStream.removeTrack(mediaTrack); } catch {}
    });
    room.on(RoomEvent.Disconnected, () => {
      // Clean up state but don't surface as a crash - the parent
      // hardDisconnect path will trigger a full teardown anyway.
    });
    try {
      // Force media to traverse LiveKit Cloud's TURN/TLS relays on 443/TCP
      // instead of trying UDP first. The direct UDP path is blocked on many
      // corporate / mobile / hotspot networks, which causes the
      // "could not establish pc connection" failure followed by a 1006 WS
      // close. Routing through TURN adds ~30-80ms of latency but is the
      // only path that reliably works from arbitrary networks. For voice
      // (single audio track, ~20-40 kbps) the latency hit is inaudible.
      await room.connect(tokenResp.url, tokenResp.token, {
        rtcConfig: {
          iceTransportPolicy: "relay",
        },
      });
    } catch (err) {
      console.error("[voice] room.connect failed:", err);
      try { await room.disconnect(); } catch {}
      return false;
    }
    if (this.destroyed) {
      try { await room.disconnect(); } catch {}
      return false;
    }
    this.room = room;
    // Pre-deliver an empty stream so the UI can attach it to the <audio>
    // element and call play() under a user gesture. Tracks will be added
    // to this same stream as participants publish.
    if (!this.deliveredOnce) {
      this.handlers.onRemoteAudioStream?.(this.remoteStream);
    }
    return true;
  }

  async openMic(): Promise<boolean> {
    if (this.destroyed || !this.room) return false;
    if (this.micTrack) {
      await this.micTrack.unmute().catch(() => {});
      this.handlers.onMicStateChange?.(true);
      return true;
    }
    let track: LocalAudioTrack;
    try {
      track = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
    } catch (err) {
      console.error("[voice] createLocalAudioTrack:", err);
      return false;
    }
    if (this.destroyed) {
      track.stop();
      return false;
    }
    try {
      await this.room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        dtx: true,
        red: true,
      });
    } catch (err) {
      console.error("[voice] publishTrack:", err);
      try { track.stop(); } catch {}
      return false;
    }
    this.micTrack = track;
    this.handlers.onMicStateChange?.(true);
    return true;
  }

  closeMic(): void {
    const track = this.micTrack;
    this.micTrack = null;
    if (!this.destroyed && this.room && track) {
      this.room.localParticipant.unpublishTrack(track, true).catch((err) => {
        console.warn("[voice] unpublishTrack:", err);
      });
    } else if (track) {
      try { track.stop(); } catch {}
    }
    this.handlers.onMicStateChange?.(false);
  }

  isMicOpen(): boolean {
    return this.micTrack !== null;
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closeMic();
    const room = this.room;
    this.room = null;
    if (room) {
      room.disconnect().catch((err) => console.warn("[voice] disconnect:", err));
    }
  }
}
