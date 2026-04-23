"use client";

import { useEffect, useState, useCallback } from "react";
import type { PublicDevice } from "@rc/protocol";
import styles from "./page.module.css";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relayHttpUrl(): string {
  // 1. Build-time override (set in Render / Vercel dashboard) — accept either
  // the wss://relay.example.com form or an https://relay.example.com form.
  const envUrl = process.env.NEXT_PUBLIC_RELAY_URL;
  if (envUrl) {
    return envUrl
      .replace(/^wss?:\/\//, (m) => (m === "wss://" ? "https://" : "http://"))
      .replace(/\/relay$/, "");
  }

  if (typeof window === "undefined") return "http://localhost:4000";
  const { protocol, hostname } = window.location;
  const base = protocol === "https:" ? `https://${window.location.host}` : `http://${hostname}:4000`;
  return base.replace(/\/relay$/, "");
}

/** Local info server on the host machine — loopback-only by design. */
function localInfoUrl(): string {
  const port = process.env.NEXT_PUBLIC_LOCAL_PORT ?? "4001";
  return `http://localhost:${port}/info`;
}

/** URL to open on another device to land on the picker. */
function pickerUrl(): string {
  if (typeof window === "undefined") return "";
  const { protocol, hostname, port } = window.location;
  return `${protocol}//${hostname}${port ? `:${port}` : ""}/`;
}

/**
 * One-tap share URL that auto-pairs the controller to this host.
 * The picker reads `?d=<deviceId>&p=<pin>` and calls connect() automatically.
 * This is the "zero-click" CRD-style flow — paste in Slack/Teams/iMessage.
 */
function shareUrl(deviceId: string, pin: string): string {
  const base = pickerUrl();
  if (!base) return "";
  const qs = new URLSearchParams({ d: deviceId, p: pin });
  return `${base}?${qs.toString()}`;
}

interface LocalInfo {
  deviceId:   string;
  deviceName: string;
  pin:        string;
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
  const pollRelay = useCallback(async (deviceId: string) => {
    try {
      const res = await fetch(`${relayHttpUrl()}/devices`);
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
    void pollRelay(info.deviceId);
    const id = setInterval(() => pollRelay(info.deviceId), 2000);
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
              <span className={styles.urlText} title={shareUrl(info.deviceId, info.pin)}>
                {shareUrl(info.deviceId, info.pin)}
              </span>
              <button
                className={`${styles.copyBtn} ${copyDone === "share" ? styles.copyDone : ""}`}
                onClick={() => copy(shareUrl(info.deviceId, info.pin), "share")}
              >
                {copyDone === "share" ? "✓ Copied" : "Copy link"}
              </button>
            </div>

            <div className={styles.urlLabel}>Or pair manually with the PIN:</div>
            <div className={styles.urlRow}>
              <span className={styles.urlText}>{pickerUrl()}</span>
              <button
                className={`${styles.copyBtn} ${copyDone === "url" ? styles.copyDone : ""}`}
                onClick={() => copy(pickerUrl(), "url")}
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
