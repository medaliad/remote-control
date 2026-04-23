import type { InputEvent } from "./input";

export const TAG_CONTROL = 0x01;
export const TAG_VIDEO   = 0x02;
export const TAG_AUDIO   = 0x03;
/** Raw s16le PCM from the controller's microphone → sent to the host. */
export const TAG_MIC     = 0x04;

export type FrameTag =
  | typeof TAG_CONTROL
  | typeof TAG_VIDEO
  | typeof TAG_AUDIO
  | typeof TAG_MIC;

export type Role = "controller" | "host";

/**
 * Wire control messages. The model is Chrome Remote Desktop-style:
 *
 *   - A **host** has a stable `deviceId` (persisted across restarts) and a
 *     human-readable `deviceName`. On boot it generates an ephemeral 6-digit
 *     `pin` and announces itself with `register-host`.
 *   - A **controller** lists available devices via the relay's HTTP API,
 *     picks one, and connects with `connect-controller` carrying the device's
 *     PIN. The relay verifies the PIN before pairing the two sockets.
 */
export type ControlMessage =
  // ── Host → relay ─────────────────────────────────────────────────────────
  | { type: "register-host"; deviceId: string; deviceName: string; pin: string }
  // ── Controller → relay ───────────────────────────────────────────────────
  | { type: "connect-controller"; deviceId: string; pin: string; controllerName?: string }
  // ── Relay → peer ─────────────────────────────────────────────────────────
  | { type: "host-registered" }
  | { type: "peer-joined"; role: Role; name?: string }
  | { type: "peer-left"; role: Role }
  | { type: "error"; reason: string }
  // ── Controller ↔ host (forwarded by relay) ───────────────────────────────
  | { type: "input"; event: InputEvent };

export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_CHUNK_BYTES = 640; // 20ms @ 16kHz mono s16le

/**
 * Public shape returned by the relay's `GET /devices` endpoint.
 * Never includes the PIN — that stays on the host machine.
 */
export interface PublicDevice {
  deviceId:   string;
  deviceName: string;
  status:     "available" | "busy";
}
