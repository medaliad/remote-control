"use client";

/**
 * Browser-only host flow. The user clicks "Start sharing", picks a window via
 * navigator.mediaDevices.getDisplayMedia, and the page:
 *
 *   1. Generates a random deviceId + 6-digit PIN.
 *   2. Opens a WebSocket to /relay and registers as a host (same protocol the
 *      native apps/host agent uses — relay stays untouched).
 *   3. Waits for a peer (the /join page on another device).
 *   4. When paired, creates an RTCPeerConnection, adds the screen-share track,
 *      and exchanges SDP + ICE through the relay as binary control frames.
 *
 * The viewer just sees the video — no mouse, no keyboard. Browser sandbox
 * doesn't let us do anything more than that without a native agent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

// ─── Wire protocol ──────────────────────────────────────────────────────────
// Must match apps/signaling/src/main.ts + combined-server.mjs: 0x01 is JSON
// control frames. We don't introduce a new tag — signaling SDP/ICE just rides
// inside a control message with `type: "signal"`. The relay forwards it
// byte-for-byte to the paired peer.
const TAG_CONTROL = 0x01;

function encodeControl(msg: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg));
  const buf = new Uint8Array(1 + json.length);
  buf[0] = TAG_CONTROL;
  buf.set(json, 1);
  return buf;
}

function decodeControl(buf: ArrayBuffer): Record<string, unknown> | null {
  const arr = new Uint8Array(buf);
  if (arr.length < 2 || arr[0] !== TAG_CONTROL) return null;
  try { return JSON.parse(new TextDecoder().decode(arr.subarray(1))); }
  catch { return null; }
}

function relayUrl(): string {
  const { protocol, host } = window.location;
  return (protocol === "https:" ? "wss://" : "ws://") + host + "/relay";
}

function newDeviceId(): string {
  // Crypto is available in modern browsers. Fallback to Math.random just in case.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "dev-" + Math.random().toString(36).slice(2, 12);
}

function newPin(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone (browser)";
  if (/Android/.test(ua))     return "Android (browser)";
  if (/Mac/.test(ua))         return "Mac (browser)";
  if (/Windows/.test(ua))     return "Windows (browser)";
  if (/Linux/.test(ua))       return "Linux (browser)";
  return "Browser host";
}

type Status = "idle" | "connecting" | "waiting" | "paired" | "streaming" | "ended" | "error";

export default function SharePage() {
  const [status, setStatus] = useState<Status>("idle");
  const [pin,    setPin]    = useState<string>("");
  const [error,  setError]  = useState<string>("");
  const [copied, setCopied] = useState<"pin" | "link" | null>(null);

  const deviceIdRef = useRef<string>("");
  const wsRef       = useRef<WebSocket | null>(null);
  const pcRef       = useRef<RTCPeerConnection | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const videoRef    = useRef<HTMLVideoElement | null>(null);

  const shareLink = useMemo(() => {
    if (!deviceIdRef.current || !pin) return "";
    const base = typeof window !== "undefined" ? window.location.origin : "";
    return `${base}/join#d=${deviceIdRef.current}&p=${pin}`;
  }, [pin]);

  const cleanup = useCallback(() => {
    pcRef.current?.close();       pcRef.current = null;
    wsRef.current?.close();       wsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startSharing = useCallback(async () => {
    setError("");
    setStatus("connecting");
    try {
      // 1. Ask browser to pick a window/screen.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      // If the user stops sharing via the browser's own banner, end the session.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setStatus("ended");
        cleanup();
      });

      // 2. Generate identity + pin.
      deviceIdRef.current = newDeviceId();
      const thisPin = newPin();
      setPin(thisPin);

      // 3. Open relay WS and register as host.
      const ws = new WebSocket(relayUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        ws.send(encodeControl({
          type:       "register-host",
          deviceId:   deviceIdRef.current,
          deviceName: defaultDeviceName(),
          pin:        thisPin,
        }));
      });

      ws.addEventListener("error", () => {
        setError("Relay connection failed.");
        setStatus("error");
      });

      ws.addEventListener("close", () => {
        if (statusRef.current !== "ended") {
          setStatus("ended");
        }
      });

      ws.addEventListener("message", async (ev) => {
        const msg = decodeControl(ev.data as ArrayBuffer);
        if (!msg) return;

        if (msg.type === "host-registered") {
          setStatus("waiting");
          return;
        }

        if (msg.type === "peer-joined") {
          setStatus("paired");
          await beginWebRTCOffer(stream, ws);
          return;
        }

        if (msg.type === "peer-left") {
          pcRef.current?.close();
          pcRef.current = null;
          setStatus("waiting");
          return;
        }

        if (msg.type === "error") {
          setError(String(msg.reason ?? "unknown relay error"));
          setStatus("error");
          return;
        }

        if (msg.type === "signal") {
          const pc = pcRef.current;
          if (!pc) return;
          const payload = msg.payload as { answer?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit } | undefined;
          if (!payload) return;
          if (payload.answer) {
            await pc.setRemoteDescription(payload.answer);
          } else if (payload.ice) {
            try { await pc.addIceCandidate(payload.ice); } catch { /* ignore */ }
          }
        }
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === "NotAllowedError") {
        setError("Screen share was cancelled.");
      } else {
        setError(err?.message ?? "Could not start sharing.");
      }
      setStatus("error");
      cleanup();
    }
  }, [cleanup]);

  // Track latest status in a ref so the ws "close" handler can inspect it
  // without closing over a stale value.
  const statusRef = useRef<Status>("idle");
  useEffect(() => { statusRef.current = status; }, [status]);

  const beginWebRTCOffer = useCallback(async (stream: MediaStream, ws: WebSocket) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
    pcRef.current = pc;

    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeControl({ type: "signal", payload: { ice: e.candidate.toJSON() } }));
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") setStatus("streaming");
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setError("Peer connection lost.");
        setStatus("error");
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(encodeControl({
      type: "signal",
      payload: { offer: { type: offer.type, sdp: offer.sdp } },
    }));
  }, []);

  const stopSharing = useCallback(() => {
    cleanup();
    setStatus("ended");
  }, [cleanup]);

  const copy = useCallback((text: string, kind: "pin" | "link") => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(kind);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const statusLabel =
      status === "idle"        ? "Ready"
    : status === "connecting"  ? "Requesting screen…"
    : status === "waiting"     ? "Waiting for your friend to join…"
    : status === "paired"      ? "Friend joined — starting video…"
    : status === "streaming"   ? "Live — your friend can see your screen"
    : status === "ended"       ? "Session ended"
    : status === "error"       ? "Error"
    : "";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logoMark}>🖥</span>
        <span>Share your screen</span>
      </header>

      <main className={styles.main}>
        {status === "idle" && (
          <div className={styles.card}>
            <h1 className={styles.title}>Let a friend watch your screen</h1>
            <p className={styles.sub}>
              No install. Your browser will ask which window or screen to share.
              They will see it live — they cannot click or type.
            </p>
            <button className={styles.primary} onClick={startSharing}>
              Start sharing
            </button>
          </div>
        )}

        {status !== "idle" && (
          <div className={styles.card}>
            <div className={`${styles.status} ${styles["status_" + status]}`}>
              {statusLabel}
            </div>

            {error && <div className={styles.error}>{error}</div>}

            {pin && status !== "ended" && status !== "error" && (
              <>
                <div className={styles.pinLabel}>Send this PIN to your friend</div>
                <div className={styles.pin} onClick={() => copy(pin, "pin")}>{pin}</div>
                <button className={styles.ghost} onClick={() => copy(pin, "pin")}>
                  {copied === "pin" ? "✓ PIN copied" : "Copy PIN"}
                </button>

                <div className={styles.orSep}>or share this direct link</div>
                <div className={styles.linkRow}>
                  <code className={styles.link}>{shareLink}</code>
                  <button className={styles.ghost} onClick={() => copy(shareLink, "link")}>
                    {copied === "link" ? "✓ Link copied" : "Copy link"}
                  </button>
                </div>
              </>
            )}

            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className={styles.preview}
            />

            {status !== "ended" && status !== "error" && (
              <button className={styles.danger} onClick={stopSharing}>
                Stop sharing
              </button>
            )}

            {(status === "ended" || status === "error") && (
              <button className={styles.primary} onClick={() => { setStatus("idle"); setPin(""); setError(""); }}>
                Start a new session
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
