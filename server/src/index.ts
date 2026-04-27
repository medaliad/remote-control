/**
 * Remote-Access signaling server.
 *
 * One process, one port. Serves:
 *   - the built Vite SPA from ../web/dist/ (GET /, /host, /client, assets)
 *   - the WebSocket signaling endpoint at /ws
 *   - a cheap /health endpoint for Render's health check
 *
 * Everything interesting lives in SessionManager. This file is just the
 * HTTP/WS glue and dispatcher.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import { SessionManager, send } from "./session-manager.js";
import type { AgentToServer, ClientToServer, ServerToAgent } from "./types.js";

/* ─── Config ────────────────────────────────────────────────────────────── */

const PORT = Number(process.env.PORT ?? 3000);
/**
 * Auth for the manager → server pairing call (POST /api/sessions/open).
 *
 * Two layers, both optional but at least one is recommended in production:
 *
 *   AUTOPAIR_TOKEN     A shared secret presented as `Authorization: Bearer …`
 *                      or as `?key=…` on the URL. If unset we accept any
 *                      caller — fine for local dev, NOT fine on the public
 *                      internet because anyone who knew the URL could pop
 *                      open-session toasts on every registered agent.
 *
 *   AUTOPAIR_ALLOWED_ORIGINS
 *                      Comma-separated list of Origins (the manager's web
 *                      origin) that may CORS-call this endpoint. Defaults
 *                      to "*" — change in production.
 */
const AUTOPAIR_TOKEN = process.env.AUTOPAIR_TOKEN ?? "";
const AUTOPAIR_ALLOWED_ORIGINS = (process.env.AUTOPAIR_ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Tolerate running from source (tsx) and from dist/ — resolve relative to me.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WEB_ROOT = process.env.WEB_ROOT
  ? resolve(process.env.WEB_ROOT)
  : resolve(__dirname, "..", "..", "web", "dist");
// Ping interval — below the ~100-110s idle reap Render/Cloudflare enforce.
const PING_INTERVAL_MS = 25_000;
const BOOT_TIME = Date.now();

const sessions = new SessionManager();

/* ─── Static file server ────────────────────────────────────────────────── */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Strip query string, normalize, refuse path traversal.
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  const safe    = normalize(urlPath).replace(/^[/\\]+/, "");
  const abs     = join(WEB_ROOT, safe);
  if (!abs.startsWith(WEB_ROOT)) { res.writeHead(403).end(); return; }

  let file = abs;
  try {
    const s = await stat(abs);
    if (s.isDirectory()) file = join(abs, "index.html");
  } catch {
    // Fall through — might be a route the SPA handles. We'll try index.html.
  }

  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    // SPA fallback: serve index.html for any unknown path so client-side
    // routing works on deep links.
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
    "Content-Type":  MIME[ext] ?? "application/octet-stream",
    // Hashed Vite assets are safe to cache hard; the HTML shell should not be.
    "Cache-Control": file.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
  });
  res.end(data);
}

/* ─── HTTP ──────────────────────────────────────────────────────────────── */

const httpServer = createServer(async (req, res) => {
  // Tiny health probe for Render — cheap, no work, no state.
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        ok:        true,
        uptimeSec: Math.round((Date.now() - BOOT_TIME) / 1000),
        ...sessions.snapshot(),
      }),
    );
    return;
  }

  /* CORS pre-flight for /api/* — manager UIs live on a different origin
   * (the VE Admin app) and need to call /api/sessions/open from JS. */
  if (req.url?.startsWith("/api/") && req.method === "OPTIONS") {
    writeCors(req, res);
    res.writeHead(204).end();
    return;
  }

  // Auto-pair endpoints — see handleApi for routing.
  if (req.url?.startsWith("/api/") && req.method === "POST") {
    await handleApi(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  await serveStatic(req, res);
});

/**
 * /api/* dispatcher. We hand-roll routing because the rest of the server
 * is a single-file affair and pulling in Express for two endpoints is
 * overkill. Two routes today:
 *
 *   POST /api/sessions/open   → mint pairing token, push to agent
 *   POST /api/agent/lookup    → debugging helper, returns whether the
 *                                given user has a live registered agent
 */
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
    const user = (body && typeof body.user === "string") ? body.user : "";
    if (!authorize(req, url)) return writeJson(res, 401, { ok: false, error: "unauthorized" });
    const agent = sessions.lookupAgent(user);
    return writeJson(res, 200, {
      ok:    true,
      user:  user,
      live:  Boolean(agent),
      agent: agent ? { agentId: agent.agentId, registeredAt: agent.registeredAt } : null,
    });
  }
  if (path === "/api/users/login") {
    /* Tiny presence ping. The VE Admin app POSTs here on login so the
     * remote server has a record of "user X is currently signed in to VE
     * Admin from <origin>". This is informational only — the canonical
     * agent-online check is still the live /agent WebSocket. We store the
     * record so /api/sessions/open responses can include a hint when an
     * agent isn't yet connected for a freshly-logged-in user. */
    if (!authorize(req, url)) return writeJson(res, 401, { ok: false, error: "unauthorized" });
    const body = await readJsonBody(req);
    const user        = (body && typeof body.user        === "string") ? body.user.trim()        : "";
    const displayName = (body && typeof body.displayName === "string") ? body.displayName.trim() : "";
    if (!user) return writeJson(res, 400, { ok: false, error: "missing-user" });
    presence.set(user.toLowerCase(), {
      user:        user.toLowerCase(),
      displayName: displayName || user,
      lastSeen:    Date.now(),
      origin:      String(req.headers.origin ?? ""),
    });
    const agent = sessions.lookupAgent(user);
    return writeJson(res, 200, {
      ok:        true,
      user:      user.toLowerCase(),
      agentLive: Boolean(agent),
    });
  }
  writeJson(res, 404, { ok: false, error: "not-found" });
}

/* ─── Presence (login-record bookkeeping) ───────────────────────────── */
/** username → last-login record. In-memory, single-process; same lifetime
 *  rules as everything else here. The map size is bounded by sweeping
 *  entries older than 24h on read. */
interface PresenceEntry {
  user:        string;
  displayName: string;
  lastSeen:    number;
  origin:      string;
}
const presence = new Map<string, PresenceEntry>();
const PRESENCE_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [k, v] of presence) if (v.lastSeen < cutoff) presence.delete(k);
}, 60 * 60 * 1000).unref();

/** POST /api/sessions/open
 *  body:    { targetUser: string, managerName?: string }
 *  returns: { ok: true, token, expiresAt, code? }   on success
 *           { ok: false, error: "..." }              on failure
 *
 * The "code" field is *only* present if the agent has already claimed and
 * the host page bound a session code by the time we respond — generally
 * that race resolves on the agent side and the manager-client picks it
 * up from peer:ready instead.
 */
async function openSessionRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!authorize(req, url)) return writeJson(res, 401, { ok: false, error: "unauthorized" });
  const body = await readJsonBody(req);
  if (!body) return writeJson(res, 400, { ok: false, error: "bad-json" });

  const targetUser  = typeof body.targetUser  === "string" ? body.targetUser.trim()  : "";
  const managerName = typeof body.managerName === "string" ? body.managerName.trim() : "";
  if (!targetUser) return writeJson(res, 400, { ok: false, error: "missing-targetUser" });

  const agent = sessions.lookupAgent(targetUser);
  if (!agent) {
    return writeJson(res, 404, {
      ok:     false,
      error:  "agent-offline",
      detail: `No live agent registered for user "${targetUser}". Make sure the agent is running on their PC.`,
    });
  }

  const pairing = sessions.mintToken(targetUser, managerName);
  // Push the open-session message to the agent. The agent is expected to
  // open the host page in its default browser pointed at /#/host?token=…
  // The agent's handler (in agent/agent.js) does exactly that.
  const push: ServerToAgent = {
    type:        "open-session",
    token:       pairing.token,
    managerName: pairing.managerName,
    expiresAt:   pairing.expiresAt,
  };
  try { agent.ws.send(JSON.stringify(push)); }
  catch (err) {
    return writeJson(res, 502, { ok: false, error: "agent-push-failed", detail: String((err as Error)?.message ?? err) });
  }

  console.log(`[autopair] mint user="${targetUser}" manager="${managerName || "?"}" token=${pairing.token.slice(0, 8)}…`);
  return writeJson(res, 200, {
    ok:        true,
    token:     pairing.token,
    expiresAt: pairing.expiresAt,
    user:      targetUser,
  });
}

/* ─── HTTP helpers (CORS, JSON I/O, auth) ───────────────────────────── */

function writeCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "";
  const allow =
    AUTOPAIR_ALLOWED_ORIGINS.includes("*") ? "*"
    : AUTOPAIR_ALLOWED_ORIGINS.includes(origin) ? origin
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

/** Cap body to 16 KB — we only ever expect tiny JSON. */
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
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Bearer-or-?key auth. Open if AUTOPAIR_TOKEN is empty (dev mode). */
function authorize(req: IncomingMessage, url: URL): boolean {
  if (!AUTOPAIR_TOKEN) return true;
  const header = String(req.headers.authorization ?? "");
  if (header.startsWith("Bearer ") && header.slice(7).trim() === AUTOPAIR_TOKEN) return true;
  if (url.searchParams.get("key") === AUTOPAIR_TOKEN) return true;
  return false;
}

/* ─── WebSocket signaling ──────────────────────────────────────────────── */

const wss      = new WebSocketServer({ noServer: true });
/** Separate server for the /agent control channel. We keep it on its own
 *  WSS instance so the dispatcher and lifecycle logic don't tangle with the
 *  manager/host/client browser sockets above. */
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

wss.on("connection", (ws: WebSocket) => {
  sessions.attach(ws);

  // Keepalive bookkeeping — see PING_INTERVAL_MS below.
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on("pong", () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });

  ws.on("message", (buf) => handleMessage(ws, buf.toString("utf8")));
  ws.on("close",   ()    => handleClose(ws));
  ws.on("error",   (err) => console.warn("[ws] socket error:", err.message));
});

/* ─── Agent control channel ─────────────────────────────────────────── */
//
// The local agent on each user's PC keeps one of these open. It's a tiny
// JSON protocol (see types.ts AgentToServer / ServerToAgent):
//
//   client → server:  agent:hello { user, agentId }   on connect
//                     agent:ping                       every ~25s
//   server → client:  agent:registered                 reply to hello
//                     open-session  { token, ... }     server-pushed
//                     agent:pong                       reply to ping

agentWss.on("connection", (ws: WebSocket, req) => {
  // Same keepalive bookkeeping as the browser socket. WebSockets behind
  // Render / Cloudflare get reaped after ~110s of idle so we ping the
  // agent every PING_INTERVAL_MS too.
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on("pong", () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });

  ws.on("message", (buf) => {
    let msg: AgentToServer;
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      if (!parsed || typeof parsed.type !== "string") throw new Error("no type");
      msg = parsed as AgentToServer;
    } catch {
      // Don't reply: the agent shouldn't be sending garbage. Logging at info
      // (not warn) because a misbehaving extension on the user's PC could
      // otherwise spam the server log.
      return;
    }
    switch (msg.type) {
      case "agent:hello": {
        const user    = String(msg.user    ?? "").trim();
        const agentId = String(msg.agentId ?? "").trim();
        if (!user || !agentId) {
          try { ws.send(JSON.stringify({ type: "error", code: "bad-message", message: "user/agentId required" })); }
          catch { /* ignore */ }
          return;
        }
        const entry = sessions.registerAgent(ws, user, agentId);
        const reply: ServerToAgent = { type: "agent:registered", user: entry.user, agentId: entry.agentId };
        try { ws.send(JSON.stringify(reply)); } catch { /* ignore */ }
        console.log(`[agent] registered user="${entry.user}" agentId=${entry.agentId} (origin=${req.headers.origin ?? "-"})`);
        return;
      }
      case "agent:ping": {
        const reply: ServerToAgent = { type: "agent:pong" };
        try { ws.send(JSON.stringify(reply)); } catch { /* ignore */ }
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
    /* ── Host ops ─────────────────────────────────────────────────────── */
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
      // Auto-pair host path: agent opened the host page with ?token=… and
      // the page is asking us to bind a session under that pairing. We
      // mint a normal session and tag it with the token so the manager's
      // client:claim can find it.
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
      console.log(`[session] host-claim code=${r.session.code} user="${r.pairing.user}" pre-paired=${r.pairedClient ? "yes" : "no"}`);
      // Same shape as host:create — UI stays uniform.
      send(ws, { type: "session:created", code: r.session.code });
      // If a manager was already waiting on this token, fire the same
      // pair-ready sequence as a manual approve / claimTokenAsClient
      // would. The manager's `request:approved` keeps the Client UI
      // moving from "waiting" → "connecting" without having to wait for
      // a re-claim.
      if (r.pairedClient) {
        send(r.pairedClient,    { type: "request:approved" });
        send(r.session.hostWs,  { type: "peer:ready", role: "host",   allowControl: r.session.allowControl });
        send(r.pairedClient,    { type: "peer:ready", role: "client", allowControl: r.session.allowControl });
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
      // Tell both peers they're paired. Client offers first by convention,
      // so it's the "polite" peer in perfect-negotiation terms.
      send(r.session.hostWs, { type: "peer:ready", role: "host",   allowControl: r.session.allowControl });
      send(r.clientWs,        { type: "peer:ready", role: "client", allowControl: r.session.allowControl });
      return;
    }
    case "host:reject": {
      const r = sessions.rejectRequest(ws, msg.requestId);
      if (!r.ok) {
        send(ws, { type: "error", code: r.reason, message: errorMessage(r.reason) });
        return;
      }
      send(r.clientWs, { type: "request:rejected", reason: msg.reason ?? "rejected by host" });
      try { r.clientWs.close(1000, "rejected"); } catch { /* ignore */ }
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
        try { s.clientWs.close(1000, "host ended"); } catch { /* ignore */ }
      }
      for (const r of s.pending.values()) {
        send(r.ws, { type: "request:rejected", reason: "session closed" });
        try { r.ws.close(1000, "session ended"); } catch { /* ignore */ }
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

    /* ── Client ops ───────────────────────────────────────────────────── */
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
      // Server ack so the client can move to "waiting for approval".
      console.log(`[session] request code=${r.session.code} requestId=${r.requestId} client="${msg.clientName ?? "Client"}"`);
      // Notify host of the incoming request — they get to decide.
      send(r.session.hostWs, {
        type:       "request:incoming",
        requestId:  r.requestId,
        clientName: msg.clientName ?? "Client",
        at:         Date.now(),
      });
      return;
    }
    case "client:claim": {
      // Auto-pair client path: manager presents the same token the agent
      // received and we pair them straight to the host bound to that token.
      // No host:approve round-trip — the token came from our own POST /api
      // /sessions/open mint, which is itself authenticated.
      const existing = sessions.getContext(ws);
      if (existing?.role || existing?.pendingRequestId) {
        send(ws, { type: "error", code: "bad-message", message: "already in a session" });
        return;
      }
      const r = sessions.claimTokenAsClient(ws, msg.token, msg.clientName ?? "Manager");
      if (r.ok === false) {
        const code = r.reason === "session-full" ? "session-full" : "invalid-token";
        send(ws, {
          type:    "error",
          code,
          message: code === "session-full"
            ? "The host already has another viewer connected."
            : "Pairing token unknown or expired.",
        });
        return;
      }
      if (r.ok === "queued") {
        // Manager arrived before the agent's host page did. We've parked
        // them on the token — host:claim will pair them up when it
        // arrives. The Client UI sits in "waiting" until then; nothing
        // visible changes here.
        console.log(`[session] auto-pair queued manager="${r.managerName}" — waiting for host:claim`);
        return;
      }
      console.log(`[session] auto-paired code=${r.session.code} manager="${r.managerName}"`);
      // Drive the same outbound sequence as a manual approve so the UI
      // (host *and* client) reaches "peer:ready" with no extra branches.
      send(r.clientWs, { type: "request:approved" });
      send(r.session.hostWs, { type: "peer:ready", role: "host",   allowControl: r.session.allowControl });
      send(r.clientWs,        { type: "peer:ready", role: "client", allowControl: r.session.allowControl });
      return;
    }
    case "client:cancel": {
      const s = sessions.cancelRequest(ws);
      if (!s) return;
      send(s.hostWs, { type: "peer:left", reason: "client cancelled request" });
      return;
    }

    /* ── WebRTC signaling relay (post-approval only) ─────────────────── */
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
      send(ws, { type: "error", code: "bad-message", message: `unknown type` });
    }
  }
}

function handleClose(ws: WebSocket): void {
  // If this socket was a manager parked on an unbound pairing token, drop
  // it from the token's pendingClient slot so a stale host:claim doesn't
  // try to wake a dead WS.
  sessions.cancelPendingClaim(ws);

  const effect = sessions.onSocketClose(ws);
  if (effect.kind === "client-left") {
    send(effect.hostWs, { type: "peer:left", reason: "client disconnected" });
    // Also flip control back off locally on the host UI (via control:changed).
    send(effect.hostWs, { type: "control:changed", allowed: false });
  } else if (effect.kind === "host-left") {
    for (const w of effect.notify) {
      send(w, { type: "peer:left", reason: "host disconnected" });
      try { w.close(1000, "host left"); } catch { /* ignore */ }
    }
  }
}

/** Human-readable form of the error codes that only the server emits. */
function errorMessage(code: string): string {
  switch (code) {
    case "invalid-code":       return "Session code not found.";
    case "session-full":       return "Session already has a connected client.";
    case "not-host":           return "Only the host can do that.";
    case "not-client":         return "Only a client can do that.";
    case "no-pending-request": return "No such pending request.";
    case "not-paired":         return "Not paired with a peer yet.";
    case "invalid-token":      return "Pairing token unknown or expired.";
    default:                   return "Request failed.";
  }
}

/* ─── Keepalive ─────────────────────────────────────────────────────────── */

const pingInterval = setInterval(() => {
  // Iterate both browser sockets and agent sockets — same liveness rules
  // apply to either: stale connections waste a slot per registered user
  // and would silently fail at session-open time.
  for (const set of [wss.clients, agentWss.clients]) {
    for (const ws of set) {
      const aliveWs = ws as WebSocket & { isAlive?: boolean };
      if (aliveWs.isAlive === false) {
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      aliveWs.isAlive = false;
      try { ws.ping(); } catch { /* next tick will terminate */ }
    }
  }
}, PING_INTERVAL_MS);
wss.on("close", () => clearInterval(pingInterval));
agentWss.on("close", () => clearInterval(pingInterval));

/* ─── Lifecycle ─────────────────────────────────────────────────────────── */

function gracefulShutdown(signal: string): void {
  console.log(`[server] ${signal} — shutting down (${wss.clients.size} browser sockets, ${agentWss.clients.size} agents)`);
  for (const set of [wss.clients, agentWss.clients]) {
    for (const ws of set) {
      try { ws.close(1012, "server restart"); } catch { /* ignore */ }
    }
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("uncaughtException",  (err) => console.error("[server] uncaughtException:",  err));
process.on("unhandledRejection", (err) => console.error("[server] unhandledRejection:", err));

httpServer.listen(PORT, "0.0.0.0", () => {
  const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME;
  const base = renderHost ? `https://${renderHost}` : `http://localhost:${PORT}`;
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server]   web       ${base}/`);
  console.log(`[server]   ws relay  ${base.replace(/^http/, "ws")}/ws`);
  console.log(`[server]   agent ch  ${base.replace(/^http/, "ws")}/agent`);
  console.log(`[server]   open-ses  POST ${base}/api/sessions/open`);
  console.log(`[server]   health    ${base}/health`);
  console.log(`[server]   webRoot   ${WEB_ROOT}`);
  if (!AUTOPAIR_TOKEN) {
    console.warn(`[server]   WARNING: AUTOPAIR_TOKEN unset — /api/sessions/open is open to all callers.`);
  }
});
