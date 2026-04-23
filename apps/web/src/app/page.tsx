"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicDevice } from "@rc/protocol";
import { RemoteScreen } from "@/presentation/RemoteScreen";
import { useRemoteSession } from "@/presentation/useRemoteSession";
import type { ConnectionState } from "@/domain/ports";
import styles from "./page.module.css";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultRelay(): string {
  // 1. Build-time override (set in Render / Vercel dashboard).
  const envUrl = process.env.NEXT_PUBLIC_RELAY_URL;
  if (envUrl) return envUrl;

  if (typeof window === "undefined") return "ws://localhost:4000";
  const { protocol, hostname } = window.location;
  // 2. Same-origin proxy (if you terminate TLS in front of both web + relay).
  return protocol === "https:"
    ? `wss://${window.location.host}/relay`
    : `ws://${hostname}:4000`;
}

function relayHttpUrl(ws: string): string {
  return ws.replace(/^wss?:\/\//, (m) => (m === "wss://" ? "https://" : "http://"))
           .replace(/\/relay$/, "");
}

function isMicContextSecure(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext || window.location.hostname === "localhost";
}

/**
 * If we can reach `http://localhost:4001/info`, the browser is on the host
 * machine itself — so we mark that device as "this computer" and block
 * connecting to it (you can't control the device you're sitting in front of).
 */
async function detectLocalDeviceId(): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:4001/info", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json() as { deviceId?: string };
    return data.deviceId ?? null;
  } catch {
    return null;
  }
}

/** Pretty controller name so the host UI can show who connected. */
function defaultControllerName(): string {
  if (typeof navigator === "undefined") return "Controller";
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua))   return "iPhone";
  if (/Android/.test(ua))       return "Android";
  if (/Mac/.test(ua))           return "Mac";
  if (/Windows/.test(ua))       return "Windows PC";
  if (/Linux/.test(ua))         return "Linux PC";
  return "Controller";
}

const STATE_LABEL: Record<ConnectionState, string> = {
  idle:         "Idle",
  connecting:   "Connecting…",
  waiting:      "Waiting for host…",
  connected:    "Connected",
  disconnected: "Disconnected",
  failed:       "Connection failed",
};

const DOT_CLASS: Record<ConnectionState, string> = {
  idle:         "statusDotIdle",
  connecting:   "statusDotConnecting",
  waiting:      "statusDotConnecting",
  connected:    "statusDotConnected",
  disconnected: "statusDotDisconnected",
  failed:       "statusDotFailed",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const [relayUrl, setRelayUrl] = useState(() => {
    if (typeof window === "undefined") return defaultRelay();
    return new URLSearchParams(window.location.search).get("r") ?? defaultRelay();
  });

  const [showSettings, setShowSettings] = useState(false);

  // Device list (polled from the relay).
  const [devices,      setDevices]      = useState<PublicDevice[]>([]);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [firstLoad,    setFirstLoad]    = useState(true);

  // If this browser is on the host machine, this is the device's id.
  const [selfDeviceId, setSelfDeviceId] = useState<string | null>(null);

  // The device the user picked — opens the PIN step.
  const [selected, setSelected] = useState<PublicDevice | null>(null);
  const [pin,      setPin]      = useState("");

  const appRef = useRef<HTMLDivElement>(null);
  const pinInputRef = useRef<HTMLInputElement>(null);

  // ── Poll /devices every 2 s while on the picker ─────────────────────────────
  const pollDevices = useCallback(async () => {
    try {
      const res = await fetch(`${relayHttpUrl(relayUrl)}/devices`);
      if (!res.ok) throw new Error(`relay ${res.status}`);
      const data = await res.json() as { devices: PublicDevice[] };
      setDevices(data.devices);
      setDevicesError(null);
    } catch {
      setDevicesError("Cannot reach relay server.");
    } finally {
      setFirstLoad(false);
    }
  }, [relayUrl]);

  const {
    state, fps, hostName, errorMsg,
    micActive, micError, listening,
    attachCanvas, connect, sendInput, disconnect,
    toggleMic, toggleListen,
  } = useRemoteSession(relayUrl);

  const isConnected = state === "connected";
  const isBusy      = state === "connecting" || state === "waiting" || state === "connected";
  const onPicker    = !isBusy && !selected;
  const micContextSecure = isMicContextSecure();

  useEffect(() => {
    if (isBusy) return;
    void pollDevices();
    const id = setInterval(pollDevices, 2000);
    return () => clearInterval(id);
  }, [pollDevices, isBusy]);

  // Detect whether we're sitting on the host machine (loopback info server).
  useEffect(() => {
    let cancelled = false;
    void detectLocalDeviceId().then((id) => {
      if (!cancelled) setSelfDeviceId(id);
    });
    return () => { cancelled = true; };
  }, []);

  // Focus the PIN input when we open the PIN step.
  useEffect(() => {
    if (selected) setTimeout(() => pinInputRef.current?.focus(), 50);
  }, [selected]);

  // If a connection attempt fails, bounce back to the PIN step so the user can retry.
  useEffect(() => {
    if (state === "failed" && selected) {
      // keep selected so the error card shows in context
    }
  }, [state, selected]);

  // ── PIN input formatting ─────────────────────────────────────────────────────
  const handlePinChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value.replace(/[^0-9]/g, "").slice(0, 6);
    if (val.length > 3) val = `${val.slice(0, 3)}-${val.slice(3)}`;
    setPin(val);
  }, []);

  const submitPin = useCallback(() => {
    if (!selected) return;
    const clean = pin.replace("-", "");
    if (clean.length !== 6) return;
    connect({
      deviceId:       selected.deviceId,
      pin:            `${clean.slice(0, 3)}-${clean.slice(3)}`,
      controllerName: defaultControllerName(),
    });
  }, [pin, selected, connect]);

  const handlePinKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submitPin();
  }, [submitPin]);

  const cancelSelection = useCallback(() => {
    setSelected(null);
    setPin("");
    disconnect();
  }, [disconnect]);

  const toggleFullscreen = useCallback(() => {
    const el = appRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen();
    else document.exitFullscreen();
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div ref={appRef} className={styles.app}>

      {/* ── DEVICE PICKER ─────────────────────────────────────────────────── */}
      {onPicker && (
        <div className={styles.pickerScreen}>
          <div className={styles.pickerSettingsWrap}>
            <button
              className={`${styles.btnIcon} ${showSettings ? styles.btnIconActive : ""}`}
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Open settings"
              title="Settings"
            >
              ⚙
            </button>
            {showSettings && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 20 }}
                  onClick={() => setShowSettings(false)}
                />
                <div className={styles.settingsPanel}>
                  <div className={styles.settingsField}>
                    <span className={styles.settingsFieldLabel}>Relay URL</span>
                    <input
                      className={styles.settingsInput}
                      value={relayUrl}
                      onChange={(e) => setRelayUrl(e.target.value)}
                      placeholder="wss://your-relay.example.com"
                      spellCheck={false}
                      autoFocus
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          <div className={styles.pickerHeader}>
            <div className={styles.pickerLogo}>
              <span className={styles.pickerLogoMark}>🖥</span>
              <span className={styles.pickerLogoText}>Remote Control</span>
            </div>
            <h1 className={styles.pickerTitle}>Your devices</h1>
            <p className={styles.pickerSubtitle}>
              Pick a computer to control. Only devices running the host app on
              the same relay will appear here.
            </p>
          </div>

          <div className={styles.deviceList}>
            {firstLoad && (
              <div className={styles.deviceListEmpty}>
                <div className={styles.spinnerLarge} />
                <span>Looking for devices…</span>
              </div>
            )}

            {!firstLoad && devicesError && (
              <div className={styles.deviceListEmpty}>
                <span className={styles.emptyIcon}>⚠</span>
                <span className={styles.emptyTitle}>{devicesError}</span>
                <span className={styles.emptyHint}>
                  Check that the relay is running at{" "}
                  <code>{relayUrl}</code>.
                </span>
              </div>
            )}

            {!firstLoad && !devicesError && devices.length === 0 && (
              <div className={styles.deviceListEmpty}>
                <span className={styles.emptyIcon}>💻</span>
                <span className={styles.emptyTitle}>No devices online</span>
                <span className={styles.emptyHint}>
                  On the computer you want to control, run{" "}
                  <code>npm run dev:host</code>. To connect from another
                  device, open this page at the host's LAN address (e.g.{" "}
                  <code>http://192.168.x.x:3000</code>) and make sure ports{" "}
                  <code>3000</code> and <code>4000</code> are allowed through
                  its firewall.
                </span>
              </div>
            )}

            {devices.map((d) => {
              const isSelf = selfDeviceId === d.deviceId;
              const disabled = d.status === "busy" || isSelf;
              const statusLabel =
                isSelf              ? "This computer"
                : d.status === "busy" ? "Busy"
                                      : "Online";
              const titleText =
                isSelf              ? "You're on the host computer — connect from another device"
                : d.status === "busy" ? "Device already has a controller connected"
                                      : "Connect";
              return (
                <button
                  key={d.deviceId}
                  className={`${styles.deviceCard} ${disabled ? styles.deviceCardBusy : ""} ${isSelf ? styles.deviceCardSelf : ""}`}
                  onClick={() => !disabled && setSelected(d)}
                  disabled={disabled}
                  title={titleText}
                >
                  <span className={styles.deviceIcon}>🖥</span>
                  <span className={styles.deviceBody}>
                    <span className={styles.deviceName}>
                      {d.deviceName}
                      {isSelf && <span className={styles.deviceSelfTag}>this device</span>}
                    </span>
                    <span
                      className={styles.deviceStatus}
                      data-status={isSelf ? "self" : d.status}
                    >
                      <span className={styles.deviceStatusDot} />
                      {statusLabel}
                    </span>
                  </span>
                  <span className={styles.deviceArrow}>›</span>
                </button>
              );
            })}
          </div>

          {selfDeviceId ? (
            <p className={styles.pickerFooter}>
              This computer is the host. Open{" "}
              <a href="/host" className={styles.pickerFooterLink}>/host</a> to
              see its PIN, then connect from a different device (phone, tablet,
              other laptop).
            </p>
          ) : (
            <p className={styles.pickerFooter}>
              Running the host on this machine? Open{" "}
              <a href="/host" className={styles.pickerFooterLink}>/host</a> to
              see its PIN.
            </p>
          )}
        </div>
      )}

      {/* ── PIN STEP ───────────────────────────────────────────────────────── */}
      {!isBusy && selected && (
        <div className={styles.pickerScreen}>
          <div className={styles.pinCard}>
            <button className={styles.backBtn} onClick={cancelSelection}>‹ Back</button>

            <span className={styles.pinDeviceIcon}>🖥</span>
            <h2 className={styles.pinDeviceName}>{selected.deviceName}</h2>
            <p className={styles.pinHint}>
              Enter the PIN shown on the host computer.
            </p>

            {state === "failed" && errorMsg && (
              <div className={styles.connectStatus} data-kind="error">
                {errorMsg}
              </div>
            )}

            <input
              ref={pinInputRef}
              className={styles.pinInput}
              value={pin}
              onChange={handlePinChange}
              onKeyDown={handlePinKey}
              placeholder="000-000"
              maxLength={7}
              inputMode="numeric"
              spellCheck={false}
              aria-label="PIN"
            />

            <button
              className={styles.connectBtn}
              onClick={submitPin}
              disabled={pin.replace("-", "").length < 6}
            >
              Connect
            </button>

            {!micContextSecure && (
              <div className={styles.connectStatus} data-kind="warn">
                🎤 Mic input requires HTTPS (will be disabled).
              </div>
            )}
            {micContextSecure && micError && (
              <div className={styles.connectStatus} data-kind="error">
                🎤 {micError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── CONNECTING / WAITING ──────────────────────────────────────────── */}
      {(state === "connecting" || state === "waiting") && (
        <div className={styles.pickerScreen}>
          <div className={styles.pinCard}>
            <span className={styles.pinDeviceIcon}>🖥</span>
            <h2 className={styles.pinDeviceName}>{selected?.deviceName ?? "Host"}</h2>
            <div className={styles.spinnerLarge} />
            <span className={styles.connectingLabel}>{STATE_LABEL[state]}</span>
            <button className={styles.cancelBtn} onClick={cancelSelection}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── CONNECTED ──────────────────────────────────────────────────────── */}
      {isConnected && (
        <div className={styles.connectedLayout}>
          <header className={styles.connectedBar}>
            <div className={styles.logo}>
              <span className={styles.logoMark}>🖥</span>
              Remote Control
            </div>

            <div className={styles.divider} />

            {hostName && (
              <span className={styles.hostBadge} title="Connected computer">
                🖥 {hostName}
              </span>
            )}

            <div className={styles.spacer} />

            <button
              className={`${styles.audioBtn} ${micActive ? styles.audioBtnMicOn : ""}`}
              onClick={toggleMic}
              disabled={!micContextSecure}
              title={
                !micContextSecure
                  ? "Mic requires HTTPS"
                  : micActive ? "Mute microphone" : "Open microphone"
              }
            >
              {micActive ? "🎤 Mic On" : "🎤 Mic Off"}
            </button>

            <button
              className={`${styles.audioBtn} ${!listening ? styles.audioBtnMuted : ""}`}
              onClick={toggleListen}
              title={listening ? "Mute host audio" : "Unmute host audio"}
            >
              {listening ? "🔊 Listen" : "🔇 Muted"}
            </button>

            <div className={styles.divider} />

            <button className={styles.fullscreenBtn} onClick={toggleFullscreen} title="Fullscreen">
              ⛶
            </button>

            <button className={styles.btnDisconnect} onClick={cancelSelection}>
              Disconnect
            </button>
          </header>

          <div className={styles.canvasArea}>
            <RemoteScreen
              attachCanvas={attachCanvas}
              onInput={sendInput}
              captureInput={true}
              visible={true}
            />
          </div>

          <footer className={styles.statusBar}>
            <div className={styles.statusItem}>
              <span className={`${styles.statusDot} ${styles[DOT_CLASS[state]]}`} />
              <span className={styles.statusText}>{STATE_LABEL[state]}</span>
            </div>
            <div className={styles.statusSep} />
            <div className={styles.fpsBadge}>
              <span>fps</span>
              <span style={{ color: fps > 0 ? "var(--text)" : undefined }}>{fps}</span>
            </div>
            <div className={styles.statusSep} />
            <span className={`${styles.kbBadge} ${styles.kbBadgeActive}`}>
              ⌨&nbsp;Keyboard active
            </span>
          </footer>
        </div>
      )}

    </div>
  );
}
