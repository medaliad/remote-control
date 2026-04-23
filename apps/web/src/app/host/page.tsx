"use client";

import { useEffect, useState, useCallback } from "react";
import type { PublicDevice } from "@rc/protocol";
import styles from "./page.module.css";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Base URL where the web UI + relay is publicly reachable. Derived from the
 * host agent's configured relay URL when we have it (so a localhost /host page
 * still builds a share link that points at the public relay), falling back to
 * the page's own origin.
 */
function publicBase(relayUrl: string | undefined): string {
  if (relayUrl) {
    // wss://host[:port]/relay  →  https://host[:port]
    // ws://host[:port]/relay   →  http://host[:port]
    try {
      const u = new URL(relayUrl);
      const scheme = u.protocol === "wss:" ? "https:" : "http:";
      return `${scheme}//${u.host}`;
    } catch { /* fall through */ }
  }
  if (typeof window === "undefined") return "";
  const { protocol, host } = window.location;
  return `${protocol}//${host}`;
}

function relayHttpUrl(relayUrl: string | undefined): string {
  return publicBase(relayUrl);
}

/** Local info server on the host machine — loopback-only by design. */
function localInfoUrl(): string {
  const port = process.env.NEXT_PUBLIC_LOCAL_PORT ?? "4001";
  return `http://localhost:${port}/info`;
}

/** URL to open on another device to land on the picker. */
function pickerUrl(relayUrl: string | undefined): string {
  const base = publicBase(relayUrl);
  return base ? `${base}/` : "";
}

/**
 * One-tap share URL that auto-pairs the controller to this host.
 * The picker reads `?d=<deviceId>&p=<pin>` and calls connect() automatically.
 * Built from the CONFIGURED relay so it works from outside this machine —
 * this is the key difference from naively using window.location.
 */
function shareUrl(deviceId: string, pin: string, relayUrl: string | undefined): string {
  const base = pickerUrl(relayUrl);
  if (!base) return "";
  const qs = new URLSearchParams({ d: deviceId, p: pin });
  return `${base}?${qs.toString()}`;
}

interface LocalInfo {
  deviceId:   string;
  deviceName: string;
  pin:        string;
  relayUrl?:  string; // new — surfaced by the host agent so the link we
                      // generate points at the public relay.
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HostPage() {
  const [info,       setInfo]       = useState<LocalInfo | null>(null);
  const [status,     setStatus]     = useState<"available" | "busy" | "offline">("offline");
  const [error,      setError]      = useState<string | null>(null);
  const [copyDone,   setCopyDone]   = useState<"pin" | "url" | "share" | null>(null);

  // Fetch the PIN from the *local* host agent (loopback only).
  const pollLocal = useCallback(async () => {
    try {
      const res = await fetch(localInfoUrl());
      if (!res.ok) throw new Error(`local ${res.status}`);
      const data = await res.json() as LocalInfo;
      setInfo(data);
      setError(null);
    } catch {
      setInfo(null);
      setError(
        "The host app is not running on this computer. Start it to generate a PIN."
      );
    }
  }, []);

  // Fetch status (available / busy) from the relay.
  const pollRelay = useCallback(async (deviceId: string, relayUrl: string | undefined) => {
    try {
      const res = await fetch(`${relayHttpUrl(relayUrl)}/devices`);
      if (!res.ok) throw new Error(`relay ${res.status}`);
      const data = await res.json() as { devices: PublicDevice[] };
      const me = data.devices.find((d) => d.deviceId === deviceId);
      setStatus(me ? me.status : "offline");
    } catch {
      setStatus("offline");
    }
  }, []);

  useEffect(() => {
    void pollLocal();
    const id = setInterval(pollLocal, 2000);
    return () => clearInterval(id);
  }, [pollLocal]);

  useEffect(() => {
    if (!info) return;
    void pollRelay(info.deviceId, info.relayUrl);
    const id = setInterval(() => pollRelay(info.deviceId, info.relayUrl), 2000);
    return () => clearInterval(id);
  }, [info, pollRelay]);

  const copy = useCallback((text: string, kind: "pin" | "url" | "share") => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopyDone(kind);
    setTimeout(() => setCopyDone(null), 2000);
  }, []);

  const statusLabel =
    status === "busy"      ? "Controller connected"
    : status === "available" ? "Ready to pair"
    : "Host offline";

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoMark}>🖥</span>
          Remote Control — Host
        </div>
      </header>

      <main className={styles.main}>
        {error && !info && (
          <div className={styles.card}>
            <div className={styles.errorIcon}>⚠</div>
            <p className={styles.errorText}>{error}</p>
            <p className={styles.hint}>
              Run <code>npm run host</code> on the machine you want to
              control. Then reload this page.
            </p>
          </div>
        )}

        {info && (
          <div className={styles.card}>

            <div
              className={`${styles.statusBadge} ${
                status === "busy" ? styles.statusConnected : styles.statusWaiting
              }`}
            >
              <span className={styles.statusDot} />
              {statusLabel}
            </div>

            <div className={styles.deviceNameLabel}>This computer</div>
            <div className={styles.deviceName}>{info.deviceName}</div>

            <div className={styles.pinLabel}>Share this PIN to pair a device</div>
            <div
              className={styles.pinDisplay}
              title="Click to copy"
              onClick={() => copy(info.pin, "pin")}
            >
              {info.pin}
            </div>
            <button
              className={`${styles.copyInlineBtn} ${copyDone === "pin" ? styles.copyDone : ""}`}
              onClick={() => copy(info.pin, "pin")}
            >
              {copyDone === "pin" ? "✓ PIN copied" : "Copy PIN"}
            </button>

            <div className={styles.urlLabel}>One-tap share link (auto-pairs):</div>
            <div className={styles.urlRow}>
              <span className={styles.urlText} title={shareUrl(info.deviceId, info.pin, info.relayUrl)}>
                {shareUrl(info.deviceId, info.pin, info.relayUrl)}
              </span>
              <button
                className={`${styles.copyBtn} ${copyDone === "share" ? styles.copyDone : ""}`}
                onClick={() => copy(shareUrl(info.deviceId, info.pin, info.relayUrl), "share")}
              >
                {copyDone === "share" ? "✓ Copied" : "Copy link"}
              </button>
            </div>

            <div className={styles.urlLabel}>Or pair manually with the PIN:</div>
            <div className={styles.urlRow}>
              <span className={styles.urlText}>{pickerUrl(info.relayUrl)}</span>
              <button
                className={`${styles.copyBtn} ${copyDone === "url" ? styles.copyDone : ""}`}
                onClick={() => copy(pickerUrl(info.relayUrl), "url")}
              >
                {copyDone === "url" ? "✓ Copied" : "Copy"}
              </button>
            </div>

            <p className={styles.hint}>
              The PIN changes every time the host restarts. The device name
              stays the same, so it always appears under{" "}
              <strong>{info.deviceName}</strong> in the picker.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
