import {
  TAG_AUDIO,
  TAG_CONTROL,
  TAG_MIC,
  TAG_VIDEO,
  type ControlMessage,
  type InputEvent,
} from "@rc/protocol";
import type {
  ConnectRequest,
  ConnectionState,
  TransportPort,
} from "@/domain/ports";

export class WebSocketTransport implements TransportPort {
  private ws: WebSocket | null = null;
  private onVideoH:    ((b: Uint8Array) => void) | null = null;
  private onAudioH:    ((b: Uint8Array) => void) | null = null;
  private onControlH:  ((m: ControlMessage) => void) | null = null;
  private onStateH:    ((s: ConnectionState) => void) | null = null;
  private onPeerNameH: ((name: string) => void) | null = null;
  private onErrorH:    ((reason: string) => void) | null = null;

  constructor(private readonly url: string) {}

  connect(req: ConnectRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      this.emitState("connecting");
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        this.sendControl(
          req.controllerName !== undefined
            ? { type: "connect-controller", deviceId: req.deviceId, pin: req.pin, controllerName: req.controllerName }
            : { type: "connect-controller", deviceId: req.deviceId, pin: req.pin }
        );
        // Relay will either confirm with `peer-joined` (host online + correct PIN)
        // or reject with `error`. Until then we're "waiting".
        this.emitState("waiting");
      };
      ws.onerror = () => {
        this.emitState("failed");
        settle(() => reject(new Error("relay connection failed")));
      };
      ws.onclose = () => {
        settle(() => resolve());
        this.emitState("disconnected");
      };
      ws.onmessage = (ev) => {
        const data = ev.data;
        if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
        const view    = new Uint8Array(data);
        const tag     = view[0];
        const payload = view.subarray(1);

        if (tag === TAG_VIDEO) this.onVideoH?.(payload);
        else if (tag === TAG_AUDIO) this.onAudioH?.(payload);
        else if (tag === TAG_CONTROL) {
          try {
            const text = new TextDecoder().decode(payload);
            const msg  = JSON.parse(text) as ControlMessage;
            if (msg.type === "peer-joined" && msg.role === "host") {
              if (msg.name) this.onPeerNameH?.(msg.name);
              this.emitState("connected");
              settle(() => resolve());
            } else if (msg.type === "peer-left" && msg.role === "host") {
              this.emitState("waiting");
            } else if (msg.type === "error") {
              this.onErrorH?.(msg.reason);
              this.emitState("failed");
              settle(() => reject(new Error(msg.reason)));
            }
            this.onControlH?.(msg);
          } catch {
            // ignore malformed
          }
        }
      };
    });
  }

  sendInput(event: InputEvent): void {
    this.sendControl({ type: "input", event });
  }

  sendMic(pcm: Uint8Array): void {
    this.sendFramed(TAG_MIC, pcm);
  }

  sendControl(msg: ControlMessage): void {
    const json = new TextEncoder().encode(JSON.stringify(msg));
    this.sendFramed(TAG_CONTROL, json);
  }

  onVideo(handler: (jpeg: Uint8Array) => void): void    { this.onVideoH    = handler; }
  onAudio(handler: (pcm: Uint8Array) => void): void     { this.onAudioH    = handler; }
  onControl(handler: (msg: ControlMessage) => void): void { this.onControlH = handler; }
  onState(handler: (state: ConnectionState) => void): void { this.onStateH  = handler; }
  onPeerName(handler: (name: string) => void): void     { this.onPeerNameH = handler; }
  onError(handler: (reason: string) => void): void      { this.onErrorH    = handler; }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private sendFramed(tag: number, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const framed = new Uint8Array(payload.byteLength + 1);
    framed[0] = tag;
    framed.set(payload, 1);
    this.ws.send(framed);
  }

  private emitState(s: ConnectionState): void {
    this.onStateH?.(s);
  }
}
