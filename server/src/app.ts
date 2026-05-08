import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionManager, send } from "./session-manager.js";
import type { AgentToServer, ClientToServer, ServerToAgent } from "./types.js";
import { handleInstall, isInstallPath } from "./install-handler.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_WEB_ROOT = resolve(__dirname, "..", "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface AppConfig {
  autopairToken?: string;
  allowedOrigins?: string[];
  webRoot?: string;
  pingIntervalMs?: number;
}

export interface AppInstance {
  httpServer: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  agentWss: WebSocketServer;
  sessions: SessionManager;
  close(): Promise<void>;
}

type LiveWs = WebSocket & { isAlive?: boolean };

interface PresenceEntry {
  user: string;
  displayName: string;
  lastSeen: number;
  origin: string;
}

export function createApp(config: AppConfig = {}): AppInstance {
  const AUTOPAIR_TOKEN = config.autopairToken ?? "";
  const AUTOPAIR_ALLOWED_ORIGINS = config.allowedOrigins ?? ["*"];
  const WEB_ROOT = config.webRoot ?? DEFAULT_WEB_ROOT;
  const PING_INTERVAL_MS = config.pingIntervalMs ?? 25_000;
  const BOOT_TIME = Date.now();

  const sessions = new SessionManager();
  const presence = new Map<string, PresenceEntry>();
  const PRESENCE_TTL_MS = 24 * 60 * 60 * 1000;

  const presenceTimer = setInterval(() => {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [k, v] of presence) if (v.lastSeen < cutoff) presence.delete(k);
  }, 60 * 60 * 1000).unref();

  // ─── static file serving ────────────────────────────────────────────────────

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    const safe = normalize(urlPath).replace(/^[/\\]+/, "");
    const abs = join(WEB_ROOT, safe);
    if (!abs.startsWith(WEB_ROOT)) {
      res.writeHead(403).end();
      return;
    }
    let file = abs;
    try {
      const s = await stat(abs);
      if (s.isDirectory()) file = join(abs, "index.html");
    } catch {}
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      try {
        data = await readFile(join(WEB_ROOT, "index.html"));
        file = "index.html";
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
    }
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": file.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
    });
    res.end(data);
  }

  // ─── CORS + JSON helpers ─────────────────────────────────────────────────────

  function writeCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin ?? "";
    const allow = AUTOPAIR_ALLOWED_ORIGINS.includes("*")
      ? "*"
      : AUTOPAIR_ALLOWED_ORIGINS.includes(origin)
      ? origin
      : "";
    if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
  }

  function writeJson(res: ServerResponse, status: number, body: unknown): void {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.writeHead(status);
    }
    res.end(JSON.stringify(body));
  }

  async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const max = 16 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > max) return null;
      chunks.push(buf);
    }
    if (!chunks.length) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  function authorize(req: IncomingMessage, url: URL): boolean {
    if (!AUTOPAIR_TOKEN) return true;
    const header = String(req.headers.authorization ?? "");
    if (header.startsWith("Bearer ") && header.slice(7).trim() === AUTOPAIR_TOKEN) return true;
    if (url.searchParams.get("key") === AUTOPAIR_TOKEN) return true;
    return false;
  }

  // ─── API routes ──────────────────────────────────────────────────────────────

  async function openSessionRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!authorize(req, url)) return writeJson(res, 401, { ok: false, error: "unauthorized" });
    const body = await readJsonBody(req);
    if (!body) return writeJson(res, 400, { ok: false, error: "bad-json" });
    const targetUser = typeof body.targetUser === "string" ? body.targetUser.trim() : "";
    const managerName = typeof body.managerName === "string" ? body.managerName.trim() : "";
    if (!targetUser) return writeJson(res, 400, { ok: false, error: "missing-targetUser" });
    const agent = sessions.lookupAgent(targetUser);
    if (!agent) {
      return writeJson(res, 404, {
        ok: false,
        error: "agent-offline",
        detail: `No live agent registered for user "${targetUser}". Make sure the agent is running on their PC.`,
      });
    }
    const pairing = sessions.mintToken(targetUser, managerName);
    const push: ServerToAgent = {
      type: "open-session",
      token: pairing.token,
      managerName: pairing.managerName,
      expiresAt: pairing.expiresAt,
    };
    try {
      agent.ws.send(JSON.stringify(push));
    } catch (err) {
      return writeJson(res, 502, {
        ok: false,
        error: "agent-push-failed",
        detail: String((err as Error)?.message ?? err),
      });
    }
    console.log(`[autopair] mint user="${targetUser}" manager="${managerName || "?"}" token=${pairing.token.slice(0, 8)}…`);
    return writeJson(res, 200, {
      ok: true,
      token: pairing.token,
      expiresAt: pairing.expiresAt,
      user: targetUser,
    });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    writeCors(req, res);
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;

    if (path === "/api/sessions/open") {
      await openSessionRoute(req, res, url);
      return;
    }
    if (path === "/api/agent/lookup") {
      const body = await readJsonBody(req);
      const user = body && typeof body.user === "string" ? body.user : "";
      if (!authorize(req, url)) return writeJson(res, 401, { ok: false, error: "unauthorized" });
      const agent = sessions.lookupAgent(user);
      return writeJson(res, 200, {
        ok: true,
        user,
        live: Boolean(agent),
        agent: agent ? { agentId: agent.agentId, registeredAt: agent.registeredAt } : null,
      });
    }
    if (path === "/api/users/login") {
      if (!authorize(req, url)) return writeJson(res, 401, { ok: false, error: "unauthorized" });
      const body = await readJsonBody(req);
      const user = body && typeof body.user === "string" ? body.user.trim() : "";
      const displayName = body && typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (!user) return writeJson(res, 400, { ok: false, error: "missing-user" });
      presence.set(user.toLowerCase(), {
        user: user.toLowerCase(),
        displayName: displayName || user,
        lastSeen: Date.now(),
        origin: String(req.headers.origin ?? ""),
      });
      const agent = sessions.lookupAgent(user);
      return writeJson(res, 200, { ok: true, user: user.toLowerCase(), agentLive: Boolean(agent) });
    }
    writeJson(res, 404, { ok: false, error: "not-found" });
  }

  // ─── HTTP server ─────────────────────────────────────────────────────────────

  const httpServer = createServer(async (req, res) => {
    if (req.url === "/health") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - BOOT_TIME) / 1000), ...sessions.snapshot() }));
      return;
    }
    if (req.url?.startsWith("/api/") && req.method === "OPTIONS") {
      writeCors(req, res);
      res.writeHead(204).end();
      return;
    }
    if (req.url?.startsWith("/api/") && req.method === "POST") {
      await handleApi(req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    {
      const reqUrl = req.url ?? "/";
      const pathname = reqUrl.split("?")[0] ?? "/";
      if (isInstallPath(pathname)) {
        const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? "https";
        const host =
          (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ??
          (req.headers.host as string | undefined) ??
          "remote-control-cdqo.onrender.com";
        const publicBase = `${proto}://${host}`;
        await handleInstall(req, res, publicBase);
        return;
      }
    }
    await serveStatic(req, res);
  });

  // ─── WebSocket servers ───────────────────────────────────────────────────────

  const wss = new WebSocketServer({ noServer: true });
  const agentWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    if (url.pathname === "/agent") {
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
      return;
    }
    socket.destroy();
  });

  // ─── /ws connection (browser clients) ───────────────────────────────────────

  wss.on("connection", (ws: WebSocket) => {
    sessions.attach(ws);
    (ws as LiveWs).isAlive = true;
    ws.on("pong", () => { (ws as LiveWs).isAlive = true; });
    ws.on("message", (buf) => handleMessage(ws, buf.toString("utf8")));
    ws.on("close", () => handleClose(ws));
    ws.on("error", (err) => console.warn("[ws] socket error:", err.message));
  });

  // ─── /agent connection ───────────────────────────────────────────────────────

  agentWss.on("connection", (ws: WebSocket) => {
    (ws as LiveWs).isAlive = true;
    ws.on("pong", () => { (ws as LiveWs).isAlive = true; });
    ws.on("message", (buf) => {
      let msg: AgentToServer;
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        if (!parsed || typeof parsed.type !== "string") throw new Error("no type");
        msg = parsed as AgentToServer;
      } catch {
        return;
      }
      switch (msg.type) {
        case "agent:hello": {
          const user = String(msg.user ?? "").trim();
          const agentId = String(msg.agentId ?? "").trim();
          if (!user || !agentId) {
            try { ws.send(JSON.stringify({ type: "error", code: "bad-message", message: "user/agentId required" })); } catch {}
            return;
          }
          const entry = sessions.registerAgent(ws, user, agentId);
          const reply: ServerToAgent = { type: "agent:registered", user: entry.user, agentId: entry.agentId };
          try { ws.send(JSON.stringify(reply)); } catch {}
          console.log(`[agent] registered user="${entry.user}" agentId=${entry.agentId}`);
          return;
        }
        case "agent:ping": {
          const reply: ServerToAgent = { type: "agent:pong" };
          try { ws.send(JSON.stringify(reply)); } catch {}
          return;
        }
      }
    });
    ws.on("close", () => {
      const user = sessions.unregisterAgent(ws);
      if (user) console.log(`[agent] unregistered user="${user}"`);
    });
    ws.on("error", (err) => console.warn("[agent] socket error:", err.message));
  });

  // ─── WebSocket message handler ───────────────────────────────────────────────

  function handleMessage(ws: WebSocket, raw: string): void {
    let msg: ClientToServer;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.type !== "string") throw new Error("no type");
      msg = parsed as ClientToServer;
    } catch {
      send(ws, { type: "error", code: "bad-message", message: "invalid JSON" });
      return;
    }
    switch (msg.type) {
      case "host:create": {
        const existing = sessions.getContext(ws);
        if (existing?.role) {
          send(ws, { type: "error", code: "bad-message", message: "already in a session" });
          return;
        }
        const s = sessions.createSession(ws, msg.hostName ?? "Host");
        console.log(`[session] created code=${s.code} host="${s.hostName}"`);
        send(ws, { type: "session:created", code: s.code });
        return;
      }
      case "host:claim": {
        const existing = sessions.getContext(ws);
        if (existing?.role) {
          send(ws, { type: "error", code: "bad-message", message: "already in a session" });
          return;
        }
        const r = sessions.claimTokenAsHost(ws, msg.token, msg.hostName ?? "Host");
        if (!r.ok) {
          send(ws, { type: "error", code: "invalid-token", message: "Pairing token unknown or expired." });
          return;
        }
        console.log(`[session] host-claim code=${r.session.code} pre-paired=${r.pairedClient ? "yes" : "no"}`);
        send(ws, { type: "session:created", code: r.session.code });
        if (r.pairedClient) {
          send(r.pairedClient, { type: "request:approved" });
          send(r.session.hostWs, { type: "peer:ready", role: "host", allowControl: r.session.allowControl });
          send(r.pairedClient, { type: "peer:ready", role: "client", allowControl: r.session.allowControl });
        }
        return;
      }
      case "host:approve": {
        const r = sessions.approveRequest(ws, msg.requestId);
        if (!r.ok) {
          send(ws, { type: "error", code: r.reason, message: errorMessage(r.reason) });
          return;
        }
        console.log(`[session] approved code=${r.session.code} request=${msg.requestId}`);
        send(r.clientWs, { type: "request:approved" });
        send(r.session.hostWs, { type: "peer:ready", role: "host", allowControl: r.session.allowControl });
        send(r.clientWs, { type: "peer:ready", role: "client", allowControl: r.session.allowControl });
        return;
      }
      case "host:reject": {
        const r = sessions.rejectRequest(ws, msg.requestId);
        if (!r.ok) {
          send(ws, { type: "error", code: r.reason, message: errorMessage(r.reason) });
          return;
        }
        send(r.clientWs, { type: "request:rejected", reason: msg.reason ?? "rejected by host" });
        try { r.clientWs.close(1000, "rejected"); } catch {}
        return;
      }
      case "host:end": {
        const s = sessions.endSession(ws);
        if (!s) {
          send(ws, { type: "error", code: "not-host", message: "no session to end" });
          return;
        }
        if (s.clientWs) {
          send(s.clientWs, { type: "peer:left", reason: "host ended session" });
          try { s.clientWs.close(1000, "host ended"); } catch {}
        }
        for (const r of s.pending.values()) {
          send(r.ws, { type: "request:rejected", reason: "session closed" });
          try { r.ws.close(1000, "session ended"); } catch {}
        }
        console.log(`[session] ended code=${s.code}`);
        return;
      }
      case "host:setControl": {
        const s = sessions.setControl(ws, Boolean(msg.allowed));
        if (!s) {
          send(ws, { type: "error", code: "not-host", message: "no session" });
          return;
        }
        if (s.clientWs) send(s.clientWs, { type: "control:changed", allowed: s.allowControl });
        return;
      }
      case "client:join": {
        const existing = sessions.getContext(ws);
        if (existing?.role || existing?.pendingRequestId) {
          send(ws, { type: "error", code: "bad-message", message: "already in a session" });
          return;
        }
        const r = sessions.registerRequest(ws, msg.code, msg.clientName ?? "Client");
        if (!r.ok) {
          send(ws, { type: "error", code: r.reason, message: errorMessage(r.reason) });
          return;
        }
        console.log(`[session] request code=${r.session.code} requestId=${r.requestId} client="${msg.clientName ?? "Client"}"`);
        send(r.session.hostWs, {
          type: "request:incoming",
          requestId: r.requestId,
          clientName: msg.clientName ?? "Client",
          at: Date.now(),
        });
        return;
      }
      case "client:claim": {
        const existing = sessions.getContext(ws);
        if (existing?.role || existing?.pendingRequestId) {
          send(ws, { type: "error", code: "bad-message", message: "already in a session" });
          return;
        }
        const r = sessions.claimTokenAsClient(ws, msg.token, msg.clientName ?? "Manager");
        if (r.ok === false) {
          const code = r.reason === "session-full" ? "session-full" : "invalid-token";
          send(ws, {
            type: "error",
            code,
            message: code === "session-full" ? "The host already has another viewer connected." : "Pairing token unknown or expired.",
          });
          return;
        }
        if (r.ok === "queued") {
          console.log(`[session] auto-pair queued manager="${r.managerName}" — waiting for host:claim`);
          return;
        }
        console.log(`[session] auto-paired code=${r.session.code} manager="${r.managerName}"`);
        send(r.clientWs, { type: "request:approved" });
        send(r.session.hostWs, { type: "peer:ready", role: "host", allowControl: r.session.allowControl });
        send(r.clientWs, { type: "peer:ready", role: "client", allowControl: r.session.allowControl });
        return;
      }
      case "client:cancel": {
        const s = sessions.cancelRequest(ws);
        if (!s) return;
        send(s.hostWs, { type: "peer:left", reason: "client cancelled request" });
        return;
      }
      case "signal": {
        const peer = sessions.peerOf(ws);
        if (!peer) {
          send(ws, { type: "error", code: "not-paired", message: "no paired peer yet" });
          return;
        }
        send(peer, { type: "signal", data: msg.data });
        return;
      }
      default: {
        send(ws, { type: "error", code: "bad-message", message: "unknown type" });
      }
    }
  }

  function handleClose(ws: WebSocket): void {
    sessions.cancelPendingClaim(ws);
    const effect = sessions.onSocketClose(ws);
    if (effect.kind === "client-left") {
      send(effect.hostWs, { type: "peer:left", reason: "client disconnected" });
      send(effect.hostWs, { type: "control:changed", allowed: false });
    } else if (effect.kind === "host-left") {
      for (const w of effect.notify) {
        send(w, { type: "peer:left", reason: "host disconnected" });
        try { w.close(1000, "host left"); } catch {}
      }
    }
  }

  function errorMessage(code: string): string {
    switch (code) {
      case "invalid-code": return "Session code not found.";
      case "session-full": return "Session already has a connected client.";
      case "not-host": return "Only the host can do that.";
      case "not-client": return "Only a client can do that.";
      case "no-pending-request": return "No such pending request.";
      case "not-paired": return "Not paired with a peer yet.";
      case "invalid-token": return "Pairing token unknown or expired.";
      default: return "Request failed.";
    }
  }

  // ─── ping/pong keepalive ─────────────────────────────────────────────────────

  const pingInterval = setInterval(() => {
    for (const set of [wss.clients, agentWss.clients]) {
      for (const ws of set) {
        const aliveWs = ws as LiveWs;
        if (aliveWs.isAlive === false) { try { ws.terminate(); } catch {} continue; }
        aliveWs.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }
  }, PING_INTERVAL_MS);

  // ─── graceful close ──────────────────────────────────────────────────────────

  async function close(): Promise<void> {
    clearInterval(pingInterval);
    clearInterval(presenceTimer);
    for (const set of [wss.clients, agentWss.clients]) {
      for (const ws of set) { try { ws.close(1012, "server shutdown"); } catch {} }
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  return { httpServer, wss, agentWss, sessions, close };
}
