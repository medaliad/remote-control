import type { ControlMessage, InputEvent } from "@rc/protocol";

export interface InputInjectorPort {
  apply(event: InputEvent): Promise<void>;
}

export interface VideoSourcePort {
  start(onFrame: (jpeg: Buffer) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface AudioSourcePort {
  start(onChunk: (pcm: Buffer) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface HostRegistration {
  deviceId:   string;
  deviceName: string;
  pin:        string;
}

export interface TransportPort {
  /** Register this host device with the relay and keep the socket open. */
  connect(registration: HostRegistration): Promise<void>;
  sendVideo(jpeg: Buffer): void;
  sendAudio(pcm: Buffer): void;
  sendControl(msg: ControlMessage): void;
  onControl(handler: (msg: ControlMessage) => void): void;
  /** Register a handler for incoming mic PCM from the controller. */
  onMic(handler: (pcm: Buffer) => void): void;
  /**
   * Fires once when the socket closes (clean or not). Used by the host to
   * drive a reconnect loop — important behind reverse proxies (Render,
   * Cloudflare, Fly) that reap idle WebSockets after ~60s.
   */
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  close(): void;
}

/** Plays raw s16le PCM through the host machine's speakers. */
export interface AudioSinkPort {
  write(pcm: Buffer): void;
  stop(): void;
}
