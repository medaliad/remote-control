"use client";

/**
 * Browser-only viewer. Reads deviceId + PIN from the URL hash
 *   /join#d=<deviceId>&p=<pin>
 * and connects as a controller, then renders the incoming WebRTC video track
 * in a <video> element. View-only — no input is sent.
 *
 * If the URL doesn't have the hash (friend opened /join directly), it shows
 * a simple PIN + device-id form.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

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

function parseHash(): { d?: string; p?: string } {
  if (typeof window === "undefined") return {};
  const h = window.location.hash.replace(/^#/, "");
  const out: Record<string, string> = {};
  for (const kv of h.split("&")) {
    const [k, v] = kv.split("=");
    if (k && v) out[k] = decodeURIComponent(v);
  }
  return out;
}

type Status =
  | "idle"
  | "connecting"
  | "waiting"
  | "paired"
  | "streaming"
  | "ended"
  | "error";

export default function JoinPage() {
  const [status,    setStatus]    = useState<Status>("idle");
  const [error,     setError]     = useState<string>("");
  const [pinInput,  setPinInput]  = useState<string>("");
  const [devInput,  setDevInput]  = useState<string>("");

  const wsRef    = useRef<WebSocket | null>(null);
  const pcRef    = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Pull deviceId + pin from URL hash if present.
  const initial = useMemo(parseHash, []);

  const cleanup = useCallback(() => {
    pcRef.current?.close();  pcRef.current = null;
    wsRef.current?.close();  wsRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const connect = useCallback((deviceId: string, pin: string) => {
    setError("");
    setStatus("connecting");

    const ws = new WebSocket(relayUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
    pcRef.current = pc;

    pc.addEventListener("track", (e) => {
      const s = e.streams[0]; if (s && videoRef.current) videoRef.current.srcObject = s;
    });

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeControl({ type: "signal", payload: { ice: e.candidate.toJSON() } }));
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected")    setStatus("streaming");
      if (pc.connectionState === "failed") {
        setError("Peer connection failed (likely a restrictive network).");
        setStatus("error");
      }
      if (pc.connectionState === "disconnected") setStatus("ended");
    });

    ws.addEventListener("open", () => {
      ws.send(encodeControl({
        type: "connect-controller",
        deviceId,
        pin,
        controllerName: "Browser viewer",
      }));
    });

    ws.addEventListener("error", () => {
      setError("Relay connection failed.");
      setStatus("error");
    });

    ws.addEventListener("close", () => {
      if (statusRef.current !== "ended") setStatus("ended");
    });

    ws.addEventListener("message", async (ev) => {
      const msg = decodeControl(ev.data as ArrayBuffer);
      if (!msg) return;

      if (msg.type === "peer-joined") { setStatus("paired"); return; }
      if (msg.type === "peer-left")   { setStatus("ended"); return; }
      if (msg.type === "error") {
        setError(String(msg.reason ?? "unknown relay error"));
        setStatus("error");
        return;
      }

      if (msg.type === "signal") {
        const payload = msg.payload as { offer?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit } | undefined;
        if (!payload) return;
        if (payload.offer) {
          await pc.setRemoteDescription(payload.offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(encodeControl({
            type: "signal",
            payload: { answer: { type: answer.type, sdp: answer.sdp } },
          }));
        } else if (payload.ice) {
          try { await pc.addIceCandidate(payload.ice); } catch { /* ignore */ }
        }
      }
    });
  }, []);

  // Auto-connect if the URL has the hash params.
  const autoConnected = useRef(false);
  useEffect(() => {
    if (autoConnected.current) return;
    if (initial.d && initial.p) {
      autoConnected.current = true;
      connect(initial.d, initial.p);
    }
  }, [initial, connect]);

  // Track current status in a ref for the ws close handler.
  const statusRef = useRef<Status>("idle");
  useEffect(() => { statusRef.current = status; }, [status]);

  const canManualConnect = status === "idle" || status === "error" || status === "ended";

  const statusLabel =
      status === "idle"       ? "Ready"
    : status === "connecting" ? "Connecting to relay…"
    : status === "waiting"    ? "Waiting for host…"
    : status === "paired"     ? "Paired — negotiating video…"
    : status === "streaming"  ? "Live"
    : status === "ended"      ? "Session ended"
    : status === "error"      ? "Error"
    : "";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.logoMark}>👁</span>
        <span>Watch a shared screen</span>
      </header>

      <main className={styles.main}>
        {canManualConnect && !initial.d && (
          <div className={styles.card}>
            <h1 className={styles.title}>Enter the code</h1>
            <p className={styles.sub}>
              Ask your friend for the PIN and device code they see on the share page.
            </p>

            <label className={styles.label}>Device code</label>
            <input
              className={styles.input}
              value={devInput}
              onChange={(e) => setDevInput(e.target.value.trim())}
              placeholder="e.g. 7f8c1e34-…"
              spellCheck={false}
            />

            <label className={styles.label}>PIN</label>
            <input
              className={styles.input}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6 digits"
              inputMode="numeric"
              spellCheck={false}
            />

            <button
              className={styles.primary}
              disabled={!devInput || pinInput.length !== 6}
              onClick={() => connect(devInput, pinInput)}
            >
              Connect
            </button>
            {error && <div className={styles.error}>{error}</div>}
          </div>
        )}

        {(!canManualConnect || (canManualConnect && initial.d)) && (
          <div className={styles.card}>
            <div className={`${styles.status} ${styles["status_" + status]}`}>
              {statusLabel}
            </div>
            {error && <div className={styles.error}>{error}</div>}

            <video
              ref={videoRef}
              autoPlay
              playsInline
              className={styles.video}
            />

            {(status === "ended" || status === "error") && (
              <button
                className={styles.primary}
                onClick={() => {
                  cleanup();
                  autoConnected.current = false;
                  if (initial.d && initial.p) connect(initial.d, initial.p);
                  else setStatus("idle");
                }}
              >
                Reconnect
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
