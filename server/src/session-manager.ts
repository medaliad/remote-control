import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { generateCode, normalizeCode } from "./code.js";
import type { ServerToClient } from "./types.js";

/**
 * Owns all in-memory session state. One singleton per server process —
 * this is a development-grade store (no persistence, no Redis). If you need
 * to run multiple replicas behind a load balancer, add a shared backing
 * store and sticky sessions; the interface here is small enough to swap.
 */

export interface PendingRequest {
  requestId: string;
  ws: WebSocket;
  clientName: string;
  at: number;
}

export interface Session {
  code: string;
  hostWs: WebSocket;
  hostName: string;
  /** Null until a client is approved and paired. */
  clientWs: WebSocket | null;
  /** Clients knocking, waiting for host approval. Keyed by requestId. */
  pending: Map<string, PendingRequest>;
  /** Host-controlled "client may send input" flag. Starts OFF. */
  allowControl: boolean;
  createdAt: number;
}

/** Attached to each ws so we can look it up cheaply on close / message. */
export interface WsContext {
  /** The session this socket belongs to (as host or client). Null when idle. */
  sessionCode: string | null;
  /** Role within that session. */
  role: "host" | "client" | null;
  /** Only set for unresolved pending clients. */
  pendingRequestId: string | null;
}

export class SessionManager {
  /** code → session */
  private readonly byCode = new Map<string, Session>();
  /** ws → context, so close handlers don't have to scan every session. */
  private readonly contexts = new WeakMap<WebSocket, WsContext>();

  /** Issue a context record for a freshly-connected socket. */
  attach(ws: WebSocket): WsContext {
    const ctx: WsContext = { sessionCode: null, role: null, pendingRequestId: null };
    this.contexts.set(ws, ctx);
    return ctx;
  }

  getContext(ws: WebSocket): WsContext | undefined {
    return this.contexts.get(ws);
  }

  /* ── Host ops ───────────────────────────────────────────────────────── */

  createSession(ws: WebSocket, hostName: string): Session {
    // Vanishingly unlikely collision, but the loop is cheap insurance.
    let code: string;
    do { code = generateCode(6); } while (this.byCode.has(code));

    const session: Session = {
      code,
      hostWs: ws,
      hostName: hostName || "Host",
      clientWs: null,
      pending: new Map(),
      allowControl: false,
      createdAt: Date.now(),
    };
    this.byCode.set(code, session);

    const ctx = this.contexts.get(ws)!;
    ctx.sessionCode = code;
    ctx.role = "host";
    return session;
  }

  /** Approve a pending request. Returns the session on success. */
  approveRequest(hostWs: WebSocket, requestId: string):
    | { ok: true; session: Session; clientWs: WebSocket }
    | { ok: false; reason: "not-host" | "no-pending-request" | "session-full" } {
    const ctx = this.contexts.get(hostWs);
    if (!ctx || ctx.role !== "host" || !ctx.sessionCode) return { ok: false, reason: "not-host" };
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return { ok: false, reason: "not-host" };
    // Already paired — reject new approvals until the current client leaves.
    // (Meets the spec: "one active connection per session".)
    if (session.clientWs) return { ok: false, reason: "session-full" };

    const req = session.pending.get(requestId);
    if (!req) return { ok: false, reason: "no-pending-request" };
    session.pending.delete(requestId);

    session.clientWs = req.ws;
    const clientCtx = this.contexts.get(req.ws);
    if (clientCtx) {
      clientCtx.sessionCode = session.code;
      clientCtx.role = "client";
      clientCtx.pendingRequestId = null;
    }
    return { ok: true, session, clientWs: req.ws };
  }

  /** Reject a pending request. Returns the client ws to notify. */
  rejectRequest(hostWs: WebSocket, requestId: string):
    | { ok: true; clientWs: WebSocket }
    | { ok: false; reason: "not-host" | "no-pending-request" } {
    const ctx = this.contexts.get(hostWs);
    if (!ctx || ctx.role !== "host" || !ctx.sessionCode) return { ok: false, reason: "not-host" };
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return { ok: false, reason: "not-host" };

    const req = session.pending.get(requestId);
    if (!req) return { ok: false, reason: "no-pending-request" };
    session.pending.delete(requestId);

    const clientCtx = this.contexts.get(req.ws);
    if (clientCtx) clientCtx.pendingRequestId = null;
    return { ok: true, clientWs: req.ws };
  }

  /** Host ends the session explicitly. */
  endSession(hostWs: WebSocket): Session | null {
    const ctx = this.contexts.get(hostWs);
    if (!ctx || ctx.role !== "host" || !ctx.sessionCode) return null;
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return null;
    this.teardown(session, "host ended session");
    return session;
  }

  /** Update host-controlled flag. Returns the session (or null if invalid). */
  setControl(hostWs: WebSocket, allowed: boolean): Session | null {
    const ctx = this.contexts.get(hostWs);
    if (!ctx || ctx.role !== "host" || !ctx.sessionCode) return null;
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return null;
    session.allowControl = allowed;
    return session;
  }

  /* ── Client ops ─────────────────────────────────────────────────────── */

  registerRequest(
    ws: WebSocket,
    rawCode: string,
    clientName: string,
  ):
    | { ok: true; session: Session; requestId: string }
    | { ok: false; reason: "invalid-code" } {
    const code = normalizeCode(rawCode);
    const session = this.byCode.get(code);
    if (!session) return { ok: false, reason: "invalid-code" };

    const requestId = randomUUID();
    session.pending.set(requestId, {
      requestId,
      ws,
      clientName: clientName || "Client",
      at: Date.now(),
    });

    const ctx = this.contexts.get(ws);
    if (ctx) {
      ctx.sessionCode = code;
      ctx.role = null; // promoted to "client" only after approval
      ctx.pendingRequestId = requestId;
    }
    return { ok: true, session, requestId };
  }

  /** Client cancels its own pending request (only valid while pending). */
  cancelRequest(ws: WebSocket): Session | null {
    const ctx = this.contexts.get(ws);
    if (!ctx?.sessionCode || !ctx.pendingRequestId) return null;
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return null;
    session.pending.delete(ctx.pendingRequestId);
    ctx.pendingRequestId = null;
    ctx.sessionCode = null;
    return session;
  }

  /* ── Pairing lookup for signal relay ────────────────────────────────── */

  /** Get the peer of a *paired* socket, or null if not paired. */
  peerOf(ws: WebSocket): WebSocket | null {
    const ctx = this.contexts.get(ws);
    if (!ctx?.sessionCode || !ctx.role) return null;
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return null;
    if (ctx.role === "host") return session.clientWs;
    if (ctx.role === "client") return session.hostWs;
    return null;
  }

  /* ── Socket lifecycle ───────────────────────────────────────────────── */

  /**
   * Called when a socket closes for any reason. Cleans up all state and
   * notifies the other side if applicable.
   *
   * Returns a side-effect summary the caller uses to emit ServerToClient
   * messages — we intentionally don't write sockets from here so that all
   * wire I/O stays in one place.
   */
  onSocketClose(ws: WebSocket): DisconnectEffect {
    const ctx = this.contexts.get(ws);
    if (!ctx?.sessionCode) return { kind: "none" };
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return { kind: "none" };

    // Pending client (never approved). Just drop its request entry.
    if (ctx.role === null && ctx.pendingRequestId) {
      session.pending.delete(ctx.pendingRequestId);
      return { kind: "none" };
    }

    // Paired client left. Session keeps living; host can accept new requests.
    if (ctx.role === "client" && session.clientWs === ws) {
      session.clientWs = null;
      session.allowControl = false; // safety: control always starts OFF again
      return { kind: "client-left", hostWs: session.hostWs };
    }

    // Host left. Tear the whole session down.
    if (ctx.role === "host") {
      const notifyList = this.teardown(session, "host left");
      return { kind: "host-left", notify: notifyList };
    }

    return { kind: "none" };
  }

  /** Nuke a session: delete its code and gather every socket to notify. */
  private teardown(session: Session, reason: string): WebSocket[] {
    const toNotify: WebSocket[] = [];
    if (session.clientWs) toNotify.push(session.clientWs);
    for (const req of session.pending.values()) toNotify.push(req.ws);

    // Clear contexts so the closed-host handler is a no-op.
    for (const ws of [session.hostWs, session.clientWs, ...[...session.pending.values()].map((r) => r.ws)]) {
      if (!ws) continue;
      const c = this.contexts.get(ws);
      if (c) { c.sessionCode = null; c.role = null; c.pendingRequestId = null; }
    }
    this.byCode.delete(session.code);
    void reason; // captured in the teardown call-site log for now
    return toNotify;
  }

  /* ── Diagnostics ────────────────────────────────────────────────────── */

  snapshot() {
    return {
      sessions: this.byCode.size,
      totalPending: [...this.byCode.values()].reduce((n, s) => n + s.pending.size, 0),
    };
  }
}

export type DisconnectEffect =
  | { kind: "none" }
  | { kind: "client-left"; hostWs: WebSocket }
  | { kind: "host-left"; notify: WebSocket[] };

/** Convenience: safely serialize and send. Swallows errors on dead sockets. */
export function send(ws: WebSocket, msg: ServerToClient): void {
  if (ws.readyState !== 1 /* OPEN */) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* socket died — ignore */ }
}
