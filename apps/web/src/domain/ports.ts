import type { ControlMessage, InputEvent } from "@rc/protocol";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "disconnected"
  | "failed";

export interface ConnectRequest {
  deviceId:       string;
  pin:            string;
  controllerName?: string;
}

export interface TransportPort {
  connect(req: ConnectRequest): Promise<void>;
  sendInput(event: InputEvent): void;
  /** Send microphone PCM (s16le) from the controller to the host. */
  sendMic(pcm: Uint8Array): void;
  onVideo(handler: (jpeg: Uint8Array) => void): void;
  onAudio(handler: (pcm: Uint8Array) => void): void;
  onControl(handler: (msg: ControlMessage) => void): void;
  onState(handler: (state: ConnectionState) => void): void;
  /** Called once when the host peer joins, with the host's device name. */
  onPeerName(handler: (name: string) => void): void;
  /** Called with a human-readable error reason if the relay rejects us. */
  onError(handler: (reason: string) => void): void;
  close(): void;
}

export interface VideoRendererPort {
  attach(canvas: HTMLCanvasElement): void;
  render(jpeg: Uint8Array): void;
  detach(): void;
}

export interface AudioPlayerPort {
  start(): Promise<void>;
  enqueue(pcm: Uint8Array): void;
  stop(): void;
}
