import { AccessToken } from "livekit-server-sdk";

/**
 * Server-side LiveKit helper.
 *
 * The remote-control session uses simple-peer for screen + input over WebRTC.
 * Voice runs in a separate LiveKit room so the audio path is handled by a
 * battle-tested SFU instead of point-to-point ICE.
 *
 * Conventions:
 *   - Room name = the session code (uppercased).
 *   - Identity  = role + a short random suffix, e.g. "host-9f2a", "client-3bc1".
 *   - Token TTL = 1 hour, plenty for a session.
 *
 * Required env vars:
 *   LIVEKIT_URL          public WSS endpoint (e.g. wss://livekit.example.com)
 *   LIVEKIT_API_KEY      key issued by LiveKit
 *   LIVEKIT_API_SECRET   secret paired with the key
 *
 * If any are missing, the token endpoint returns 503 — the UI just
 * disables voice and the rest of the session keeps working.
 */
export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export function readLiveKitConfig(): LiveKitConfig | null {
  const url = (process.env.LIVEKIT_URL ?? "").trim();
  const apiKey = (process.env.LIVEKIT_API_KEY ?? "").trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET ?? "").trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

export interface MintTokenInput {
  config: LiveKitConfig;
  sessionCode: string;
  role: "host" | "client";
  displayName?: string;
}

export interface MintedToken {
  token: string;
  url: string;
  room: string;
  identity: string;
  expiresAt: number;
}

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

function sanitizeRoom(code: string): string {
  // LiveKit accepts most things, but keep it boring: alnum + dash, upper-case.
  return code.replace(/[^A-Za-z0-9-]/g, "").toUpperCase().slice(0, 32);
}

export async function mintLiveKitToken(input: MintTokenInput): Promise<MintedToken> {
  const room = sanitizeRoom(input.sessionCode);
  if (!room) throw new Error("invalid-session-code");
  const identity = `${input.role}-${shortId()}`;
  const at = new AccessToken(input.config.apiKey, input.config.apiSecret, {
    identity,
    name: input.displayName?.slice(0, 64) || identity,
    ttl: TOKEN_TTL_SECONDS,
  });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  const token = await at.toJwt();
  return {
    token,
    url: input.config.url,
    room,
    identity,
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
  };
}
