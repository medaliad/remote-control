import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";

/**
 * Voice over LiveKit.
 *
 * Public surface (unchanged from earlier revisions so Host/Client don't
 * need to be rewritten):
 *
 *   const v = new Voice({ onRemoteAudioStream, onMicStateChange });
 *   await v.open(sessionCode, role, displayName);    // join the SFU room
 *   await v.openMic();                               // publish mic
 *   v.closeMic();                                    // unpublish mic
 *   v.close();                                       // leave the room
 *
 * Internals worth knowing about:
 *
 *  • Media is forced through TURN/TLS (`iceTransportPolicy: "relay"`). The
 *    direct UDP path is blocked on lots of corporate / mobile / hotspot
 *    networks, which manifests as `Initial connection failed with
 *    ConnectionError: could not establish pc connection` followed by a WS
 *    1006. Forcing TURN avoids that whole class of failure at the cost of
 *    ~30-80ms of added latency, which is inaudible for voice.
 *
 *  • Mic publishing uses `setMicrophoneEnabled()`. That single call handles
 *    permission prompts, device selection, track creation, publish, mute,
 *    and re-publish on reconnect. It is far more robust than the old
 *    create/publish/unpublish dance.
 *
 *  • Remote audio is delivered as a single aggregate MediaStream via
 *    `onRemoteAudioStream`. Host.tsx/Client.tsx attach that to a hidden
 *    `<audio autoPlay playsInline>` element. We also call `Room.startAudio`
 *    on every user-gesture-driven `openMic` to defeat browser autoplay
 *    blocking.
 *
 *  • Everything is logged with a `[voice]` prefix so the console tells you
 *    exactly which step is failing when something goes wrong.
 */

export interface VoiceHandlers {
  /** Called whenever the aggregate remote audio MediaStream changes. */
  onRemoteAudioStream?: (stream: MediaStream) => void;
  /** Called when the local mic publish state changes. */
  onMicStateChange?: (open: boolean) => void;
  /** Called on any unrecoverable LiveKit disconnect. */
  onDisconnected?: (reason: string) => void;
}

interface TokenResponse {
  ok: boolean;
  token?: string;
  url?: string;
  room?: string;
  identity?: string;
  error?: string;
}

async function fetchToken(
  sessionCode: string,
  role: "host" | "client",
  displayName: string,
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch("/api/livekit/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionCode, role, displayName }),
    });
  } catch (err) {
    console.warn("[voice] token fetch threw:", err);
    return { ok: false, error: "fetch-failed" };
  }
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch {}
    const error = (body as { error?: string } | null)?.error ?? `http-${res.status}`;
    console.warn("[voice] token endpoint returned", res.status, error);
    return { ok: false, error };
  }
  return (await res.json()) as TokenResponse;
}

export class Voice {
  private room: Room | null = null;
  private destroyed = false;
  private opening: Promise<boolean> | null = null;
  private readonly handlers: VoiceHandlers;
  /** Aggregate MediaStream containing every remote audio track. */
  private readonly remoteStream = new MediaStream();
  private deliveredOnce = false;

  constructor(handlers: VoiceHandlers) {
    this.handlers = handlers;
  }

  // ─── public API ───────────────────────────────────────────────────────────

  /**
   * Join the LiveKit room for this session. Returns `false` if voice
   * isn't available (server env vars not set, network unreachable, etc.) -
   * callers should disable the mic button in that case.
   *
   * Safe to call multiple times; concurrent calls share one promise.
   */
  async open(sessionCode: string, role: "host" | "client", displayName: string): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.room && this.room.state === ConnectionState.Connected) return true;
    if (this.opening) return this.opening;
    this.opening = this.doOpen(sessionCode, role, displayName).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /**
   * Publish the local microphone. Requires `open()` to have succeeded.
   * Returns `false` if the room isn't ready or the user denied mic perms.
   */
  async openMic(): Promise<boolean> {
    if (this.destroyed) return false;
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) {
      console.warn("[voice] openMic called before room is connected (state =", room?.state ?? "no-room", ")");
      return false;
    }
    // The act of calling openMic happens inside a click handler in the UI,
    // which is a valid user gesture. Use that window to also unblock any
    // queued remote audio playback (LiveKit + browser autoplay policy).
    try {
      await room.startAudio();
    } catch (err) {
      console.warn("[voice] room.startAudio rejected (will retry on next gesture):", err);
    }
    try {
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
    } catch (err) {
      console.error("[voice] setMicrophoneEnabled(true) failed:", err);
      this.handlers.onMicStateChange?.(false);
      return false;
    }
    console.log("[voice] mic published");
    this.handlers.onMicStateChange?.(true);
    return true;
  }

  /** Stop publishing the local microphone. Idempotent. */
  closeMic(): void {
    const room = this.room;
    if (!this.destroyed && room && room.state === ConnectionState.Connected) {
      // setMicrophoneEnabled(false) unpublishes the existing mic track and
      // stops the underlying MediaStreamTrack. We don't need to await it.
      room.localParticipant.setMicrophoneEnabled(false).catch((err) => {
        console.warn("[voice] setMicrophoneEnabled(false) failed:", err);
      });
    }
    this.handlers.onMicStateChange?.(false);
  }

  isMicOpen(): boolean {
    const lp = this.room?.localParticipant;
    if (!lp) return false;
    return lp.isMicrophoneEnabled;
  }

  /** Leave the room and tear everything down. Idempotent. */
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const room = this.room;
    this.room = null;
    if (room) {
      console.log("[voice] closing room");
      room.disconnect().catch((err) => console.warn("[voice] disconnect:", err));
    }
    // Stop any tracks left in our aggregate stream so the OS mic indicator
    // actually goes away.
    for (const t of this.remoteStream.getTracks()) {
      try { this.remoteStream.removeTrack(t); } catch {}
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async doOpen(sessionCode: string, role: "host" | "client", displayName: string): Promise<boolean> {
    console.log(`[voice] opening role=${role} session=${sessionCode} name="${displayName}"`);
    const tokenResp = await fetchToken(sessionCode, role, displayName);
    if (!tokenResp.ok || !tokenResp.token || !tokenResp.url) {
      console.warn("[voice] LiveKit unavailable:", tokenResp.error);
      return false;
    }
    console.log(`[voice] token ok, url=${tokenResp.url} room=${tokenResp.room} identity=${tokenResp.identity}`);

    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      // Audio capture defaults applied to mic tracks created via
      // setMicrophoneEnabled.
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      // Stop bothering the SFU about video — voice-only room.
      publishDefaults: {
        dtx: true,
        red: true,
      },
    });

    this.wireRoomEvents(room);

    // Warm the WSS + DNS so the real connect is faster. Best-effort.
    try {
      await room.prepareConnection(tokenResp.url, tokenResp.token);
    } catch (err) {
      console.warn("[voice] prepareConnection failed (continuing):", err);
    }

    try {
      // Force media to traverse LiveKit Cloud's TURN/TLS relays on 443/TCP
      // instead of trying UDP first. See the file header for the why.
      await room.connect(tokenResp.url, tokenResp.token, {
        autoSubscribe: true,
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
    console.log(
      `[voice] connected. room=${room.name} localIdentity=${room.localParticipant.identity} ` +
      `remoteParticipants=${room.remoteParticipants.size}`,
    );

    // If there are already remote participants with audio tracks (we
    // joined after them), pull their tracks in now so the UI doesn't have
    // to wait for a TrackPublished event that never comes.
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        const track = pub.track;
        if (track) this.absorbRemoteTrack(track);
      }
    }

    // Pre-deliver the (possibly empty) aggregate stream so the UI can
    // wire it to <audio> and we're ready the moment a remote publishes.
    if (!this.deliveredOnce) {
      this.deliveredOnce = true;
      this.handlers.onRemoteAudioStream?.(this.remoteStream);
    }

    return true;
  }

  private wireRoomEvents(room: Room): void {
    room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      console.log(`[voice] connection state → ${state}`);
    });

    room.on(RoomEvent.Reconnecting, () => {
      console.warn("[voice] reconnecting…");
    });
    room.on(RoomEvent.Reconnected, () => {
      console.log("[voice] reconnected");
    });

    room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      console.log(`[voice] participant joined: ${p.identity}`);
    });
    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      console.log(`[voice] participant left: ${p.identity}`);
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      console.log(`[voice] track subscribed kind=${track.kind} from=${p.identity} sid=${pub.trackSid}`);
      if (track.kind === Track.Kind.Audio) this.absorbRemoteTrack(track);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
      console.log(`[voice] track unsubscribed kind=${track.kind} from=${p.identity}`);
      if (track.kind !== Track.Kind.Audio) return;
      const mt = track.mediaStreamTrack;
      if (!mt) return;
      try { this.remoteStream.removeTrack(mt); } catch {}
    });

    room.on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication, p: Participant) => {
      console.log(`[voice] local track published kind=${pub.kind} sid=${pub.trackSid} identity=${p.identity}`);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      console.log(`[voice] local track unpublished kind=${pub.kind} sid=${pub.trackSid}`);
    });

    room.on(RoomEvent.MediaDevicesError, (err: Error) => {
      console.error("[voice] media devices error:", err);
    });

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      console.log(`[voice] audio playback allowed=${room.canPlaybackAudio}`);
    });

    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      const reasonStr = reason !== undefined ? DisconnectReason[reason] ?? String(reason) : "unknown";
      console.warn(`[voice] disconnected: ${reasonStr}`);
      if (this.room === room) {
        // Drop our reference but don't flip `destroyed` — the parent
        // page's hardDisconnect path owns full teardown.
        this.room = null;
      }
      this.handlers.onDisconnected?.(reasonStr);
    });
  }

  private absorbRemoteTrack(track: RemoteTrack): void {
    const mt = track.mediaStreamTrack;
    if (!mt) return;
    if (!this.remoteStream.getTracks().includes(mt)) {
      this.remoteStream.addTrack(mt);
      console.log(`[voice] absorbed remote audio track id=${mt.id} → aggregate stream`);
    }
    // Re-deliver so the UI's <audio> element refreshes srcObject and
    // .play() runs again. Cheap, idempotent on the consumer side.
    this.handlers.onRemoteAudioStream?.(this.remoteStream);
  }
}
