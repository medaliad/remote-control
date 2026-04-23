/**
 * Wire protocol shared by the browser and the signaling server.
 *
 * Every message is JSON over a single WebSocket on `/ws`. The server is a
 * pure mediator: it owns session lifecycle + approval gating, and relays
 * WebRTC signaling (SDP / ICE) between the two peers after approval. The
 * media itself (screen stream) flows peer-to-peer via WebRTC — never through
 * the server.
 *
 * Design notes:
 *  - "Connection is NOT automatic" is enforced server-side: a client's
 *    `client:join` never reaches the other peer as an RTC signal until the
 *    host sends `host:approve`. If the host never approves, no SDP is ever
 *    exchanged.
 *  - Session codes are one-time: a session ends the moment the host socket
 *    closes OR the host sends `host:end`, and the code is freed immediately.
 */

/* ─── Client → Server ──────────────────────────────────────────────────── */

export type ClientToServer =
  /** Host creates a new session. Server replies with `session:created`. */
  | { type: "host:create"; hostName?: string }
  /** Host approves a pending request; server pairs the two sockets. */
  | { type: "host:approve"; requestId: string }
  /** Host rejects a pending request; server notifies the client. */
  | { type: "host:reject"; requestId: string; reason?: string }
  /** Host ends the session. Clears the code and kicks any paired client. */
  | { type: "host:end" }
  /** Host toggles the "remote control allowed" flag; relayed to the client. */
  | { type: "host:setControl"; allowed: boolean }

  /** Client asks to join a session identified by its short code. */
  | { type: "client:join"; code: string; clientName?: string }
  /** Client cancels a still-pending request. */
  | { type: "client:cancel" }

  /** WebRTC signaling relay (SDP offers/answers + ICE candidates).
   *  Only valid after approval — server drops it otherwise. */
  | { type: "signal"; data: unknown };

/* ─── Server → Client ──────────────────────────────────────────────────── */

export type ServerToClient =
  /** Sent to the host after `host:create`. `code` is the short share code. */
  | { type: "session:created"; code: string }
  /** Sent to the host when a new client is knocking. */
  | {
      type: "request:incoming";
      requestId: string;
      clientName: string;
      at: number;
    }
  /** Sent to a pending client after its request is approved — both peers
   *  are now paired and may start WebRTC signaling. */
  | { type: "request:approved" }
  /** Sent to a pending client on rejection or when the host ends the session. */
  | { type: "request:rejected"; reason: string }
  /** Either side learns the peer is ready; includes our role for clarity. */
  | { type: "peer:ready"; role: "host" | "client"; allowControl: boolean }
  /** Either side learns the peer has disconnected. */
  | { type: "peer:left"; reason: string }
  /** Host told the server to change the control flag; server forwards it. */
  | { type: "control:changed"; allowed: boolean }
  /** WebRTC signaling relay to the peer (mirror of `signal` above). */
  | { type: "signal"; data: unknown }
  /** Structured error. `code` lets the UI key off specific conditions. */
  | { type: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "invalid-code"
  | "session-full"
  | "not-host"
  | "not-client"
  | "no-pending-request"
  | "not-paired"
  | "bad-message"
  | "session-ended";
