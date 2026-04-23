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

/**
 * True when the page is being opened on the host computer itself. On a
 * remote (Render) origin, fetching http://localhost:4001/info is (a) Mixed
 * Content — browsers block it silently on https — and (b) pointless, because
 * the host agent runs on the user's machine, not in the Render container. In
 * that case we render a "how to install the agent" panel instead of the
 * inevitable "host app is not running" error.
 */
function isLocalOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".local") ||
    /^192\.168\./.test(h) ||
    /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
  );
}

/** The public origin visitors should use — i.e. this page's own origin. */
function currentPublicBase(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.host}`;
}

/** The corresponding wss://…/relay URL for the host agent to register with. */
function currentPublicRelay(): string {
  if (typeof window === "undefined") return "";
  const { protocol, host } = window.location;
  const wsProto = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${host}/relay`;
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
  const [copyDone,   setCopyDone]   = useState<"pin" | "url" | "share" | "relay" | "install" | null>(null);
  // `null` until we've mounted in the browser, so the first paint matches SSR
  // (which can't know the hostname).
  const [remoteOrigin, setRemoteOrigin] = useState<boolean | null>(null);
  useEffect(() => { setRemoteOrigin(!isLocalOrigin()); }, []);

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
    // Don't poll the loopback info server from a remote (Render) page — the
    // request is always a Mixed Content error under https and wastes the
    // polling interval. We render the deploy-guide branch instead.
    if (remoteOrigin !== false) return;
    void pollLocal();
    const id = setInterval(pollLocal, 2000);
    return () => clearInterval(id);
  }, [pollLocal, remoteOrigin]);

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
        {/* ── REMOTE ORIGIN (Render deploy, public URL) ─────────────────── */}
        {/* This page is open on the deployed relay, not on the host computer
            itself. The host agent runs on the user's *local* machine, so
            render an install guide instead of a perpetual "offline" card.   */}
        {remoteOrigin && (
          <div className={styles.card}>
            <div
              className={`${styles.statusBadge} ${styles.statusWaiting}`}
              style={{ marginBottom: 8 }}
            >
              <span className={styles.statusDot} />
              Relay is online
            </div>
            <div className={styles.deviceNameLabel}>This is your public relay</div>
            <div
              className={styles.deviceName}
              style={{ fontSize: 18, wordBreak: "break-all" }}
            >
              {currentPublicBase()}
            </div>

            <p className={styles.hint} style={{ textAlign: "left", margin: "8px 0 0" }}>
              To make a computer controllable from here, install the{" "}
              <strong>host agent</strong> on that machine and point it at this
              relay. The agent then shows up in the device picker on{" "}
              <a className={styles.pickerFooterLink ?? ""} href="/" style={{ color: "var(--accent)" }}>
                the home page
              </a>.
            </p>

            <div className={styles.urlLabel} style={{ marginTop: 18 }}>
              1. One-time setup command (run on the computer to control):
            </div>
            <div className={styles.urlRow}>
              <span className={styles.urlText}>
                {`npm run host -- --relay ${currentPublicRelay()}`}
              </span>
              <button
                className={`${styles.copyBtn} ${copyDone === "install" ? styles.copyDone : ""}`}
                onClick={() =>
                  copy(`npm run host -- --relay ${currentPublicRelay()}`, "install")
                }
              >
                {copyDone === "install" ? "✓ Copied" : "Copy"}
              </button>
            </div>

            <div className={styles.urlLabel}>2. Or just the relay URL (for env / config):</div>
            <div className={styles.urlRow}>
              <span className={styles.urlText}>{currentPublicRelay()}</span>
              <button
                className={`${styles.copyBtn} ${copyDone === "relay" ? styles.copyDone : ""}`}
                onClick={() => copy(currentPublicRelay(), "relay")}
              >
                {copyDone === "relay" ? "✓ Copied" : "Copy"}
              </button>
            </div>

            <p className={styles.hint} style={{ textAlign: "left" }}>
              After the agent starts, its one-time PIN is shown in the terminal
              and on <code>http://localhost:3000/host</code> on that same
              machine. Controllers connect by opening{" "}
              <strong>{currentPublicBase()}</strong> on any other device and
              entering the PIN.
            </p>
          </div>
        )}

        {remoteOrigin === false && error && !info && (
          <div className={styles.card}>
            <div className={styles.errorIcon}>⚠</div>
            <p className={styles.errorText}>{error}</p>
            <p className={styles.hint}>
              Run <code>npm run host</code> on the machine you want to
              control. Then reload this page.
            </p>
          </div>
        )}

        {remoteOrigin === false && info && (
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
