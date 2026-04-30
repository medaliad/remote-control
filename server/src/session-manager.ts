import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { generateCode, normalizeCode } from "./code.js";
import type { ServerToAgent, ServerToClient } from "./types.js";
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
  clientWs: WebSocket | null;
  pending: Map<string, PendingRequest>;
  allowControl: boolean;
  createdAt: number;
}
export interface WsContext {
  sessionCode: string | null;
  role: "host" | "client" | null;
  pendingRequestId: string | null;
}
export interface AgentEntry {
  user: string;
  agentId: string;
  ws: WebSocket;
  registeredAt: number;
}
export interface PairingToken {
  token: string;
  user: string;
  managerName: string;
  hostCode: string | null;
  pendingClient: {
    ws: WebSocket;
    clientName: string;
  } | null;
  expiresAt: number;
  createdAt: number;
}
const TOKEN_TTL_MS = 60_000;
export class SessionManager {
  private readonly byCode = new Map<string, Session>();
  private readonly contexts = new WeakMap<WebSocket, WsContext>();
  private readonly agents = new Map<string, AgentEntry>();
  private readonly agentByWs = new WeakMap<WebSocket, string>();
  private readonly tokens = new Map<string, PairingToken>();
  attach(ws: WebSocket): WsContext {
    const ctx: WsContext = {
      sessionCode: null,
      role: null,
      pendingRequestId: null
    };
    this.contexts.set(ws, ctx);
    return ctx;
  }
  getContext(ws: WebSocket): WsContext | undefined {
    return this.contexts.get(ws);
  }
  createSession(ws: WebSocket, hostName: string): Session {
    let code: string;
    do {
      code = generateCode(6);
    } while (this.byCode.has(code));
    const session: Session = {
      code,
      hostWs: ws,
      hostName: hostName || "Host",
      clientWs: null,
      pending: new Map(),
      allowControl: false,
      createdAt: Date.now()
    };
    this.byCode.set(code, session);
    const ctx = this.contexts.get(ws)!;
    ctx.sessionCode = code;
    ctx.role = "host";
    return session;
  }
  approveRequest(hostWs: WebSocket, requestId: string): {
    ok: true;
    session: Session;
    clientWs: WebSocket;
  } | {
    ok: false;
    reason: "not-host" | "no-pending-request" | "session-full";
  } {
    const ctx = this.contexts.get(hostWs);
    if (!ctx || ctx.role !== "host" || !ctx.sessionCode) return {
      ok: false,
      reason: "not-host"
    };
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return {
      ok: false,
      reason: "not-host"
    };
    if (session.clientWs) return {
      ok: false,
      reason: "session-full"
    };
    const req = session.pending.get(requestId);
    if (!req) return {
      ok: false,
      reason: "no-pending-request"
    };
    session.pending.delete(requestId);
    session.clientWs = req.ws;
    const clientCtx = this.contexts.get(req.ws);
    if (clientCtx) {
      clientCtx.sessionCode = session.code;
      clientCtx.role = "client";
      clientCtx.pendingRequestId = null;
    }
    return {
      ok: true,
      session,
      clientWs: req.ws
    };
  }
  rejectRequest(hostWs: WebSocket, requestId: string): {
    ok: true;
    clientWs: WebSocket;
  } | {
    ok: false;
    reason: "not-host" | "no-pending-request";
  } {
    const ctx = this.contexts.get(hostWs);
    if (!ctx || ctx.role !== "host" || !ctx.sessionCode) return {
      ok: false,
      reason: "not-host"
    };
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return {
      ok: false,
      reason: "not-host"
    };
    const req = session.pending.get(requestId);
    if (!req) return {
      ok: false,
      reason: "no-pending-request"
    };
    session.pending.delete(requestId);
    const clientCtx = this.contexts.get(req.ws);
    if (clientCtx) clientCtx.pendingRequestId = null;
    return {
      ok: true,
      clientWs: req.ws
    };
  }
  endSession(hostWs: WebSocket): Session | null {
    const ctx = this.contexts.get(hostWs);
    if (!ctx || ctx.role !== "host" || !ctx.sessionCode) return null;
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return null;
    this.teardown(session, "host ended session");
    return session;
  }
  setControl(hostWs: WebSocket, allowed: boolean): Session | null {
    const ctx = this.contexts.get(hostWs);
    if (!ctx || ctx.role !== "host" || !ctx.sessionCode) return null;
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return null;
    session.allowControl = allowed;
    return session;
  }
  registerRequest(ws: WebSocket, rawCode: string, clientName: string): {
    ok: true;
    session: Session;
    requestId: string;
  } | {
    ok: false;
    reason: "invalid-code" | "session-full";
  } {
    const code = normalizeCode(rawCode);
    const session = this.byCode.get(code);
    if (!session) return {
      ok: false,
      reason: "invalid-code"
    };
    if (session.clientWs) return {
      ok: false,
      reason: "session-full"
    };
    const requestId = randomUUID();
    session.pending.set(requestId, {
      requestId,
      ws,
      clientName: clientName || "Client",
      at: Date.now()
    });
    const ctx = this.contexts.get(ws);
    if (ctx) {
      ctx.sessionCode = code;
      ctx.role = null;
      ctx.pendingRequestId = requestId;
    }
    return {
      ok: true,
      session,
      requestId
    };
  }
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
  peerOf(ws: WebSocket): WebSocket | null {
    const ctx = this.contexts.get(ws);
    if (!ctx?.sessionCode || !ctx.role) return null;
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return null;
    if (ctx.role === "host") return session.clientWs;
    if (ctx.role === "client") return session.hostWs;
    return null;
  }
  onSocketClose(ws: WebSocket): DisconnectEffect {
    const ctx = this.contexts.get(ws);
    if (!ctx?.sessionCode) return {
      kind: "none"
    };
    const session = this.byCode.get(ctx.sessionCode);
    if (!session) return {
      kind: "none"
    };
    if (ctx.role === null && ctx.pendingRequestId) {
      session.pending.delete(ctx.pendingRequestId);
      return {
        kind: "none"
      };
    }
    if (ctx.role === "client" && session.clientWs === ws) {
      session.clientWs = null;
      session.allowControl = false;
      return {
        kind: "client-left",
        hostWs: session.hostWs
      };
    }
    if (ctx.role === "host") {
      const notifyList = this.teardown(session, "host left");
      return {
        kind: "host-left",
        notify: notifyList
      };
    }
    return {
      kind: "none"
    };
  }
  private teardown(session: Session, reason: string): WebSocket[] {
    const toNotify: WebSocket[] = [];
    if (session.clientWs) toNotify.push(session.clientWs);
    for (const req of session.pending.values()) toNotify.push(req.ws);
    for (const ws of [session.hostWs, session.clientWs, ...[...session.pending.values()].map(r => r.ws)]) {
      if (!ws) continue;
      const c = this.contexts.get(ws);
      if (c) {
        c.sessionCode = null;
        c.role = null;
        c.pendingRequestId = null;
      }
    }
    this.byCode.delete(session.code);
    void reason;
    return toNotify;
  }
  registerAgent(ws: WebSocket, user: string, agentId: string): AgentEntry {
    const key = normalizeUser(user);
    const previous = this.agents.get(key);
    if (previous && previous.ws !== ws) {
      this.agentByWs.delete(previous.ws);
      try {
        previous.ws.close(1000, "agent replaced");
      } catch {}
    }
    const entry: AgentEntry = {
      user: key,
      agentId,
      ws,
      registeredAt: Date.now()
    };
    this.agents.set(key, entry);
    this.agentByWs.set(ws, key);
    return entry;
  }
  unregisterAgent(ws: WebSocket): string | null {
    const user = this.agentByWs.get(ws);
    if (!user) return null;
    this.agentByWs.delete(ws);
    const entry = this.agents.get(user);
    if (entry && entry.ws === ws) this.agents.delete(user);
    return user;
  }
  lookupAgent(user: string): AgentEntry | null {
    return this.agents.get(normalizeUser(user)) ?? null;
  }
  mintToken(user: string, managerName: string): PairingToken {
    this.sweepTokens();
    const token = randomUUID().replace(/-/g, "");
    const record: PairingToken = {
      token,
      user: normalizeUser(user),
      managerName: managerName || "Manager",
      hostCode: null,
      pendingClient: null,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      createdAt: Date.now()
    };
    this.tokens.set(token, record);
    return record;
  }
  claimTokenAsHost(ws: WebSocket, token: string, hostName: string): {
    ok: true;
    session: Session;
    pairing: PairingToken;
    pairedClient: WebSocket | null;
  } | {
    ok: false;
    reason: "invalid-token";
  } {
    const rec = this.tokens.get(token);
    if (!rec || rec.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return {
        ok: false,
        reason: "invalid-token"
      };
    }
    if (rec.hostCode) return {
      ok: false,
      reason: "invalid-token"
    };
    const session = this.createSession(ws, hostName || `${rec.user} (Auto)`);
    rec.hostCode = session.code;
    let pairedClient: WebSocket | null = null;
    if (rec.pendingClient) {
      const {
        ws: clientWs
      } = rec.pendingClient;
      if (clientWs.readyState === 1) {
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
      this.tokens.delete(token);
    }
    return {
      ok: true,
      session,
      pairing: rec,
      pairedClient
    };
  }
  claimTokenAsClient(ws: WebSocket, token: string, clientName: string): {
    ok: true;
    session: Session;
    clientWs: WebSocket;
    managerName: string;
  } | {
    ok: "queued";
    managerName: string;
  } | {
    ok: false;
    reason: "invalid-token" | "session-full";
  } {
    const rec = this.tokens.get(token);
    if (!rec || rec.expiresAt < Date.now()) {
      this.tokens.delete(token);
      return {
        ok: false,
        reason: "invalid-token"
      };
    }
    if (!rec.hostCode) {
      if (rec.pendingClient && rec.pendingClient.ws !== ws) {
        return {
          ok: false,
          reason: "invalid-token"
        };
      }
      rec.pendingClient = {
        ws,
        clientName: clientName || "Manager"
      };
      const ctx = this.contexts.get(ws);
      if (ctx) ctx.sessionCode = `pending:${token}`;
      return {
        ok: "queued",
        managerName: rec.managerName
      };
    }
    const session = this.byCode.get(rec.hostCode);
    if (!session) {
      this.tokens.delete(token);
      return {
        ok: false,
        reason: "invalid-token"
      };
    }
    if (session.clientWs) return {
      ok: false,
      reason: "session-full"
    };
    this.tokens.delete(token);
    session.clientWs = ws;
    const ctx = this.contexts.get(ws);
    if (ctx) {
      ctx.sessionCode = session.code;
      ctx.role = "client";
      ctx.pendingRequestId = null;
    }
    return {
      ok: true,
      session,
      clientWs: ws,
      managerName: rec.managerName
    };
  }
  cancelPendingClaim(ws: WebSocket): void {
    const ctx = this.contexts.get(ws);
    if (!ctx?.sessionCode || !ctx.sessionCode.startsWith("pending:")) return;
    const token = ctx.sessionCode.slice("pending:".length);
    const rec = this.tokens.get(token);
    if (rec?.pendingClient?.ws === ws) rec.pendingClient = null;
    ctx.sessionCode = null;
  }
  private sweepTokens(): void {
    const now = Date.now();
    for (const [token, rec] of this.tokens) {
      if (rec.expiresAt < now) this.tokens.delete(token);
    }
  }
  snapshot() {
    return {
      sessions: this.byCode.size,
      totalPending: [...this.byCode.values()].reduce((n, s) => n + s.pending.size, 0),
      agents: this.agents.size,
      tokens: this.tokens.size
    };
  }
}
function normalizeUser(user: string): string {
  return (user ?? "").trim().toLowerCase();
}
export type DisconnectEffect = {
  kind: "none";
} | {
  kind: "client-left";
  hostWs: WebSocket;
} | {
  kind: "host-left";
  notify: WebSocket[];
};
export function send(ws: WebSocket, msg: ServerToClient): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}
