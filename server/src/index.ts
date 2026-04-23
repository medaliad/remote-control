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
import type { ClientToServer } from "./types.js";

/* ─── Config ────────────────────────────────────────────────────────────── */

const PORT = Number(process.env.PORT ?? 3000);
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
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  await serveStatic(req, res);
});

/* ─── WebSocket signaling ──────────────────────────────────────────────── */

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
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
    default:                   return "Request failed.";
  }
}

/* ─── Keepalive ─────────────────────────────────────────────────────────── */

const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    const aliveWs = ws as WebSocket & { isAlive?: boolean };
    if (aliveWs.isAlive === false) {
      try { ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    aliveWs.isAlive = false;
    try { ws.ping(); } catch { /* next tick will terminate */ }
  }
}, PING_INTERVAL_MS);
wss.on("close", () => clearInterval(pingInterval));

/* ─── Lifecycle ─────────────────────────────────────────────────────────── */

function gracefulShutdown(signal: string): void {
  console.log(`[server] ${signal} — shutting down (${wss.clients.size} sockets)`);
  for (const ws of wss.clients) {
    try { ws.close(1012, "server restart"); } catch { /* ignore */ }
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
  console.log(`[server]   health    ${base}/health`);
  console.log(`[server]   webRoot   ${WEB_ROOT}`);
});
