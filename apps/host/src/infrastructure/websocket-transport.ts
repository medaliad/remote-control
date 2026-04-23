import WebSocket from "ws";
import {
  TAG_AUDIO,
  TAG_CONTROL,
  TAG_MIC,
  TAG_VIDEO,
  type ControlMessage,
} from "@rc/protocol";
import type { HostRegistration, TransportPort } from "@/domain/ports";

/**
 * Interval at which we send a WebSocket ping while idle. Must be shorter
 * than the shortest idle-timeout of any proxy in the path. Render's router
 * is ~60s; 25s is a comfortable floor that also matches Heroku/Cloudflare.
 */
const PING_INTERVAL_MS = 25_000;

/**
 * If we don't get a pong within this many ms after a ping, we consider the
 * socket dead and force-close it so the reconnect loop in main.ts kicks in.
 */
const PONG_TIMEOUT_MS = 15_000;

export class WebSocketTransport implements TransportPort {
  private ws: WebSocket | null = null;
  private handler:      ((msg: ControlMessage) => void) | null = null;
  private micHandler:   ((pcm: Buffer) => void) | null = null;
  private closeHandler: ((info: { code: number; reason: string }) => void) | null = null;

  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  /** True once the caller asked us to close — suppresses the reconnect signal. */
  private closedByUs = false;

  constructor(private readonly url: string) {}

  connect(registration: HostRegistration): Promise<void> {
    this.closedByUs = false;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.binaryType = "nodebuffer";

      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      ws.on("open", () => {
        // Register the host identity as soon as the socket is up.
        this.sendControl({
          type:       "register-host",
          deviceId:   registration.deviceId,
          deviceName: registration.deviceName,
          pin:        registration.pin,
        });
        // Start the ping/pong keepalive so idle proxies don't reap us.
        this.startKeepalive();
      });

      ws.on("pong", () => {
        // Good — socket is alive. Cancel the pong-timeout watchdog.
        if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
      });

      ws.on("error", (err) => {
        settle(() => reject(err));
      });

      ws.on("close", (code, reasonBuf) => {
        this.stopKeepalive();
        const reason = reasonBuf?.toString?.("utf8") ?? "";
        // If we never got 'host-registered', surface the close as a connect failure.
        settle(() => reject(new Error(`socket closed before register (code=${code}, reason="${reason}")`)));
        if (!this.closedByUs) this.closeHandler?.({ code, reason });
      });

      ws.on("message", (raw: Buffer) => {
        if (raw.length < 1) return;
        const tag     = raw[0];
        const payload = raw.subarray(1);
        if (tag === TAG_CONTROL) {
          try {
            const msg = JSON.parse(payload.toString("utf8")) as ControlMessage;
            if (msg.type === "host-registered") {
              settle(() => resolve());
              return;
            }
            if (msg.type === "error" && !settled) {
              settle(() => reject(new Error(msg.reason)));
              return;
            }
            this.handler?.(msg);
          } catch {
            // ignore malformed
          }
        } else if (tag === TAG_MIC) {
          this.micHandler?.(payload);
        }
      });
    });
  }

  sendVideo(jpeg: Buffer): void   { this.sendFramed(TAG_VIDEO, jpeg); }
  sendAudio(pcm: Buffer):  void   { this.sendFramed(TAG_AUDIO, pcm); }

  sendControl(msg: ControlMessage): void {
    const json = Buffer.from(JSON.stringify(msg), "utf8");
    this.sendFramed(TAG_CONTROL, json);
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.handler = handler;
  }

  onMic(handler: (pcm: Buffer) => void): void {
    this.micHandler = handler;
  }

  onClose(handler: (info: { code: number; reason: string }) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closedByUs = true;
    this.stopKeepalive();
    this.ws?.close();
    this.ws = null;
  }

  // ── Keepalive ────────────────────────────────────────────────────────────

  private startKeepalive(): void {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try { ws.ping(); } catch { /* swallow — 'close' handler will fire next */ }

      // Watchdog: if no pong in PONG_TIMEOUT_MS, force-close so reconnect kicks in.
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        console.warn("[host] no pong from relay — force-closing to trigger reconnect");
        try { ws.terminate(); } catch { /* noop */ }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer);  this.pongTimer = null; }
  }

  private sendFramed(tag: number, payload: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const framed = Buffer.concat([Buffer.from([tag]), payload]);
    this.ws.send(framed, { binary: true });
  }
}
