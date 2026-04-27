import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { generateCode, normalizeCode } from "./code.js";
import type { ServerToAgent, ServerToClient } from "./types.js";

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

/* ─── Agent + token registry (VE Admin auto-pair path) ──────────────────── */

export interface AgentEntry {
  user: string;
  agentId: string;
  ws: WebSocket;
  registeredAt: number;
}

export interface PairingToken {
  token: string;
  /** Username this token was minted for — must match the agent that claims it. */
  user: string;
  /** Display name of the manager who initiated the open-session call. */
  managerName: string;
  /** The host's session code, set once the agent's host page sends host:claim. */
  hostCode: string | null;
  /** Manager-side socket waiting for the host to claim. The manager iframe
   *  almost always loads before the agent's browser does (the manager's
   *  request triggered the agent push, which then has to spawn a new
   *  browser process — that takes 1-3 seconds). Instead of failing the
   *  manager with "invalid-token" we queue them here and resolve the pair
   *  when host:claim eventually arrives. */
  pendingClient: { ws: WebSocket; clientName: string } | null;
  /** When this token can no longer be used. Both host:claim and client:claim
   *  must happen before this. */
  expiresAt: number;
  createdAt: number;
}

/** How long an open-session token remains usable. Short on purpose: the
 *  agent should pop the host page within seconds, not minutes. */
const TOKEN_TTL_MS = 60_000;

export class SessionManager {
  /** code → session */
  private readonly byCode = new Map<string, Session>();
  /** ws → context, so close handlers don't have to scan every session. */
  private readonly contexts = new WeakMap<WebSocket, WsContext>();
  /** username → agent control-channel entry. Last-write-wins on re-register. */
  private readonly agents = new Map<string, AgentEntry>();
  /** Reverse lookup: agent ws → username. Lets us garbage-collect on close
   *  without scanning the whole agents map. */
  private readonly agentByWs = new WeakMap<WebSocket, string>();
  /** token → pairing record. Cleaned up on use, expiry, or session end. */
  private readonly tokens = new Map<string, PairingToken>();

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
    | { ok: false; reason: "invalid-code" | "session-full" } {
    const code = normalizeCode(rawCode);
    const session = this.byCode.get(code);
    if (!session) return { ok: false, reason: "invalid-code" };
    // Spec: "one active connection per session". If a client is already
    // paired, we refuse new joins up front rather than letting them sit in
    // the pending queue until the host tries to approve. That way the
    // second client gets a clean "session-full" error instead of a silent
    // stall.
    if (session.clientWs) return { ok: false, reason: "session-full" };

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

  /* ── Agent registry (VE Admin auto-pair control channel) ────────────── */

  /**
   * Register (or re-register) an agent under a username. If another agent
   * was already registered for the same user we evict it — the most recent
   * agent wins so re-launching the local helper "just works" without
   * stranding stale entries.
   *
   * Returns the entry that ended up registered.
   */
  registerAgent(ws: WebSocket, user: string, agentId: string): AgentEntry {
    const key = normalizeUser(user);
    const previous = this.agents.get(key);
    if (previous && previous.ws !== ws) {
      // Drop the stale socket. Don't notify; the new agent owns this user.
      this.agentByWs.delete(previous.ws);
      try { previous.ws.close(1000, "agent replaced"); } catch { /* ignore */ }
    }
    const entry: AgentEntry = {
      user: key,
      agentId,
      ws,
      registeredAt: Date.now(),
    };
    this.agents.set(key, entry);
    this.agentByWs.set(ws, key);
    return entry;
  }

  /** Unregister an agent on socket close. Cheap WeakMap lookup. */
  unregisterAgent(ws: WebSocket): string | null {
    const user = this.agentByWs.get(ws);
    if (!user) return null;
    this.agentByWs.delete(ws);
    const entry = this.agents.get(user);
    if (entry && entry.ws === ws) this.agents.delete(user);
    return user;
  }

  /** Look up the live agent entry for a username, if any. */
  lookupAgent(user: string): AgentEntry | null {
    return this.agents.get(normalizeUser(user)) ?? null;
  }

  /**
   * Mint a fresh pairing token for a target user. The token is single-use
   * and short-lived. Both the host (via host:claim) and the manager-client
   * (via client:claim) must present it before the TTL expires.
   *
   * Caller is responsible for actually pushing the open-session message to
   * the agent — we only own bookkeeping here.
   */
  mintToken(user: string, managerName: string): PairingToken {
    // Sweep expired tokens lazily on each mint. Cheap, bounded work; keeps
    // the map from growing forever in long-running processes.
    this.sweepTokens();

    const token = randomUUID().replace(/-/g, "");
    const record: PairingToken = {
      token,
      user: normalizeUser(user),
      managerName: managerName || "Manager",
      hostCode: null,
      pendingClient: null,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      createdAt: Date.now(),
    };
    this.tokens.set(token, record);
    return record;
  }

  /**
   * Two-arg result of host:claim: whether the host successfully bound a
   * session, and (separately) whether a manager was already waiting and
   * just got auto-paired. The caller emits the pair-ready messages itself
   * so all wire I/O stays in the dispatcher.
   */
  /** Auto-paired manager waiter, if any. Returned alongside the host's new
   *  session so index.ts can fire the same peer:ready sequence as
   *  claimTokenAsClient. */

  /**
   * Host page presents a token. We mint a fresh session for the host (so
   * the existing code-based path still works untouched) and bind that
   * session's code to the token so the manager-client can find it later.
   *
   * If the token is unknown / expired, returns { ok: false }.
   */
  claimTokenAsHost(
    ws: WebSocket,
    token: string,
    hostName: string,
  ):
    | {
        ok: true;
        session: Session;
        pairing: PairingToken;
        /** If a manager was already waiting on this token (the common
         *  case — the iframe loads faster than the agent's browser does),
         *  we hand the host their pre-paired client right here. The
         *  caller emits peer:ready to both sides. */
        pairedClient: WebSocket | null;
      }
    | { ok: false; reason: "invalid-token" } {
    const rec = this.tokens.get(token);
    if (!rec || rec.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return { ok: false, reason: "invalid-token" };
    }
    // The host is allowed to claim only once per token. If a code is
    // already bound, refuse — somebody (likely a copy-paste of the URL)
    // is trying to start a second host on the same pairing.
    if (rec.hostCode) return { ok: false, reason: "invalid-token" };

    // Re-use the standard create flow so we don't fork session lifecycle.
    const session = this.createSession(ws, hostName || `${rec.user} (Auto)`);
    rec.hostCode = session.code;

    // Promote any waiting manager directly into the session's client slot.
    let pairedClient: WebSocket | null = null;
    if (rec.pendingClient) {
      const { ws: clientWs } = rec.pendingClient;
      // The manager might have disconnected while waiting. Skip if so.
      if (clientWs.readyState === 1 /* OPEN */) {
        session.clientWs = clientWs;
        const ctx = this.contexts.get(clientWs);
        if (ctx) {
          ctx.sessionCode = session.code;
          ctx.role = "client";
          ctx.pendingRequestId = null;
        }
        pairedClient = clientWs;
      }
      rec.pendingClient = null;
      // Token is consumed by either path — burn it now.
      this.tokens.delete(token);
    }

    return { ok: true, session, pairing: rec, pairedClient };
  }

  /**
   * Manager-client presents the same token. We pair them straight to the
   * already-bound host and return both sides so the caller can emit the
   * peer:ready / request:approved messages itself.
   *
   * Note: this skips the host's manual approve step on purpose. The token
   * was minted by an authenticated POST /api/sessions/open, and the host
   * (the agent's local browser) auto-approves anything that came from the
   * server's own mint. The host's "Allow remote input" flag still gates
   * mouse / keyboard injection — auto-pair only removes the UI ceremony
   * around connecting, not the security boundary around control.
   */
  claimTokenAsClient(
    ws: WebSocket,
    token: string,
    clientName: string,
  ):
    | { ok: true; session: Session; clientWs: WebSocket; managerName: string }
    | { ok: "queued"; managerName: string }
    | { ok: false; reason: "invalid-token" | "session-full" } {
    const rec = this.tokens.get(token);
    if (!rec || rec.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return { ok: false, reason: "invalid-token" };
    }

    // Host hasn't claimed yet — almost certainly the manager iframe just
    // loaded faster than the agent's browser launch. Park the WS on the
    // pairing record and resolve the pair when host:claim arrives.
    if (!rec.hostCode) {
      // If something else is already queued for this token, that's a
      // protocol violation (only one manager per pairing); reject.
      if (rec.pendingClient && rec.pendingClient.ws !== ws) {
        return { ok: false, reason: "invalid-token" };
      }
      rec.pendingClient = { ws, clientName: clientName || "Manager" };
      // Hint the WS context so socket-close cleanup can null this out
      // without scanning every token.
      const ctx = this.contexts.get(ws);
      if (ctx) ctx.sessionCode = `pending:${token}`; // marker; not a real code
      return { ok: "queued", managerName: rec.managerName };
    }

    const session = this.byCode.get(rec.hostCode);
    if (!session) {
      // Host left between mint and claim. Drop the token.
      this.tokens.delete(token);
      return { ok: false, reason: "invalid-token" };
    }
    if (session.clientWs) return { ok: false, reason: "session-full" };

    // Burn the token — single-use.
    this.tokens.delete(token);

    // Pair directly. No pending entry; no host:approve round-trip.
    session.clientWs = ws;
    const ctx = this.contexts.get(ws);
    if (ctx) {
      ctx.sessionCode = session.code;
      ctx.role = "client";
      ctx.pendingRequestId = null;
    }
    return { ok: true, session, clientWs: ws, managerName: rec.managerName };
  }

  /**
   * If a manager-side socket disconnects while still queued under a
   * pairing token, drop it from the token's pendingClient slot. Called
   * from the close handler. Cheap because we marked the WS context with
   * `pending:<token>` when queueing.
   */
  cancelPendingClaim(ws: WebSocket): void {
    const ctx = this.contexts.get(ws);
    if (!ctx?.sessionCode || !ctx.sessionCode.startsWith("pending:")) return;
    const token = ctx.sessionCode.slice("pending:".length);
    const rec = this.tokens.get(token);
    if (rec?.pendingClient?.ws === ws) rec.pendingClient = null;
    ctx.sessionCode = null;
  }

  /** Drop tokens whose deadline has passed. */
  private sweepTokens(): void {
    const now = Date.now();
    for (const [token, rec] of this.tokens) {
      if (rec.expiresAt < now) this.tokens.delete(token);
    }
  }

  /* ── Diagnostics ────────────────────────────────────────────────────── */

  snapshot() {
    return {
      sessions: this.byCode.size,
      totalPending: [...this.byCode.values()].reduce((n, s) => n + s.pending.size, 0),
      agents: this.agents.size,
      tokens: this.tokens.size,
    };
  }
}

/** Lower-case + trim usernames so "JDoe" and "jdoe " resolve to one slot. */
function normalizeUser(user: string): string {
  return (user ?? "").trim().toLowerCase();
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
