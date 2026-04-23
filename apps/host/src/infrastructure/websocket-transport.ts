import WebSocket from "ws";
import {
  TAG_AUDIO,
  TAG_CONTROL,
  TAG_MIC,
  TAG_VIDEO,
  type ControlMessage,
} from "@rc/protocol";
import type { HostRegistration, TransportPort } from "@/domain/ports";

export class WebSocketTransport implements TransportPort {
  private ws: WebSocket | null = null;
  private handler:    ((msg: ControlMessage) => void) | null = null;
  private micHandler: ((pcm: Buffer) => void) | null = null;

  constructor(private readonly url: string) {}

  connect(registration: HostRegistration): Promise<void> {
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
        this.sendControl({
          type:       "register-host",
          deviceId:   registration.deviceId,
          deviceName: registration.deviceName,
          pin:        registration.pin,
        });
      });
      ws.on("error", (err) => settle(() => reject(err)));
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

  sendVideo(jpeg: Buffer): void {
    this.sendFramed(TAG_VIDEO, jpeg);
  }

  sendAudio(pcm: Buffer): void {
    this.sendFramed(TAG_AUDIO, pcm);
  }

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

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private sendFramed(tag: number, payload: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const framed = Buffer.concat([Buffer.from([tag]), payload]);
    this.ws.send(framed, { binary: true });
  }
}
