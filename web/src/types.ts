/**
 * Wire protocol — intentionally a near-duplicate of server/src/types.ts.
 *
 * We don't import across the server / web boundary at build time because
 * that would couple two otherwise-independent packages and complicate the
 * Vite build. If these drift, the ws will immediately reject messages with
 * `error: bad-message`, so drift is observable in manual testing.
 */

export type ErrorCode =
  | "invalid-code"
  | "session-full"
  | "not-host"
  | "not-client"
  | "no-pending-request"
  | "not-paired"
  | "bad-message"
  | "session-ended"
  /** Token-based claim (VE Admin auto-pair) was rejected. */
  | "invalid-token";

export type ClientToServer =
  | { type: "host:create"; hostName?: string }
  /** VE Admin auto-pair host path — agent opened ?token=… */
  | { type: "host:claim"; token: string; hostName?: string }
  | { type: "host:approve"; requestId: string }
  | { type: "host:reject"; requestId: string; reason?: string }
  | { type: "host:end" }
  | { type: "host:setControl"; allowed: boolean }
  | { type: "client:join"; code: string; clientName?: string }
  /** VE Admin auto-pair client path — manager presents the same token. */
  | { type: "client:claim"; token: string; clientName?: string }
  | { type: "client:cancel" }
  | { type: "signal"; data: unknown };

export type ServerToClient =
  | { type: "session:created"; code: string }
  | {
      type: "request:incoming";
      requestId: string;
      clientName: string;
      at: number;
    }
  | { type: "request:approved" }
  | { type: "request:rejected"; reason: string }
  | { type: "peer:ready"; role: "host" | "client"; allowControl: boolean }
  | { type: "peer:left"; reason: string }
  | { type: "control:changed"; allowed: boolean }
  | { type: "signal"; data: unknown }
  | { type: "error"; code: ErrorCode; message: string };
