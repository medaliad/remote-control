// Combined server for Render: serves the Next.js web UI AND the WebSocket
// relay from a single port. The host agent is NOT in here — it runs on your
// local machine (it physically can't run in a headless cloud container).
//
// HTTP layout:
//   GET /devices      → relay device list (JSON)
//   OPTIONS *         → CORS preflight
//   everything else   → Next.js (handles /, /host, assets, etc.)
//
// WebSocket upgrade:
//   /relay            → relay protocol (binary frames, see packages/protocol)
//   any other path    → 404 (socket destroyed)
//
// Run with: node combined-server.mjs
// Port comes from $PORT (Render sets this). Falls back to 3000 locally.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import next from "next";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

// ─── Next.js ─────────────────────────────────────────────────────────────────

const app = next({
  dev:      false,
  dir:      join(__dirname, "apps", "web"),
  hostname: "0.0.0.0",
  port:     PORT,
});
const nextHandler = app.getRequestHandler();
await app.prepare();

// ─── Relay state ─────────────────────────────────────────────────────────────
// One entry per online host. Same semantics as apps/signaling/src/main.ts;
// inlined here so the combined server has no cross-workspace imports.

const TAG_CONTROL = 0x01; // see packages/protocol/src/transport.ts
const devices = new Map(); // deviceId → { deviceId, deviceName, pin, hostWs, controller }

function sendControl(ws, msg) {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  ws.send(Buffer.concat([Buffer.from([TAG_CONTROL]), json]), { binary: true });
}

function parseControl(data) {
  if (data.length < 2 || data[0] !== TAG_CONTROL) return null;
  try { return JSON.parse(data.subarray(1).toString("utf8")); }
  catch { return null; }
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
  // CORS — same-origin in production, but kept for flexibility / dev.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // Relay-only endpoint.
  if (req.url === "/devices" && req.method === "GET") {
    const list = [];
    for (const d of devices.values()) {
      if (d.hostWs.readyState !== 1 /* OPEN */) continue;
      list.push({
        deviceId:   d.deviceId,
        deviceName: d.deviceName,
        status:     d.controller ? "busy" : "available",
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" })
       .end(JSON.stringify({ devices: list }));
    return;
  }

  // Everything else → Next.js.
  try {
    await nextHandler(req, res);
  } catch (err) {
    console.error("[next] handler error:", err);
    if (!res.headersSent) res.writeHead(500).end("Internal error");
  }
});

// ─── WebSocket server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/relay") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  let joined = null; // { role: "host" | "controller", deviceId }

  ws.on("message", (raw) => {
    if (!joined) {
      const msg = parseControl(raw);
      if (!msg) {
        sendControl(ws, { type: "error", reason: "expected control frame" });
        ws.close();
        return;
      }

      if (msg.type === "register-host") {
        const existing = devices.get(msg.deviceId);
        if (existing && existing.hostWs.readyState <= 1) {
          sendControl(ws, { type: "error", reason: "device already online" });
          ws.close();
          return;
        }
        devices.set(msg.deviceId, {
          deviceId:   msg.deviceId,
          deviceName: msg.deviceName,
          pin:        msg.pin,
          hostWs:     ws,
          controller: null,
        });
        joined = { role: "host", deviceId: msg.deviceId };
        sendControl(ws, { type: "host-registered" });
        console.log(`[relay] host "${msg.deviceName}" registered (${msg.deviceId.slice(0, 8)}…)`);
        return;
      }

      if (msg.type === "connect-controller") {
        const entry = devices.get(msg.deviceId);
        if (!entry || entry.hostWs.readyState !== 1) {
          sendControl(ws, { type: "error", reason: "device not online" }); ws.close(); return;
        }
        if (entry.pin !== msg.pin) {
          sendControl(ws, { type: "error", reason: "incorrect PIN" });     ws.close(); return;
        }
        if (entry.controller && entry.controller.ws.readyState <= 1) {
          sendControl(ws, { type: "error", reason: "device is busy" });    ws.close(); return;
        }
        const name = msg.controllerName ?? "controller";
        entry.controller = { ws, name };
        joined = { role: "controller", deviceId: msg.deviceId };
        sendControl(entry.hostWs, { type: "peer-joined", role: "controller", name });
        sendControl(ws,           { type: "peer-joined", role: "host",       name: entry.deviceName });
        console.log(`[relay] controller "${name}" paired with "${entry.deviceName}"`);
        return;
      }

      sendControl(ws, { type: "error", reason: "must register-host or connect-controller first" });
      ws.close();
      return;
    }

    // Paired — forward bytes to the peer.
    const entry = devices.get(joined.deviceId);
    if (!entry) return;
    const target = joined.role === "controller" ? entry.hostWs : entry.controller?.ws;
    if (target && target.readyState === 1) target.send(raw, { binary: true });
  });

  ws.on("close", () => {
    if (!joined) return;
    const entry = devices.get(joined.deviceId);
    if (!entry) return;

    if (joined.role === "host" && entry.hostWs === ws) {
      if (entry.controller && entry.controller.ws.readyState === 1) {
        sendControl(entry.controller.ws, { type: "peer-left", role: "host" });
      }
      devices.delete(joined.deviceId);
      console.log(`[relay] host "${entry.deviceName}" offline`);
      return;
    }

    if (joined.role === "controller" && entry.controller?.ws === ws) {
      entry.controller = null;
      if (entry.hostWs.readyState === 1) {
        sendControl(entry.hostWs, { type: "peer-left", role: "controller" });
      }
      console.log(`[relay] controller left "${entry.deviceName}"`);
    }
  });
});

// ─── Listen ──────────────────────────────────────────────────────────────────

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[combined] listening on :${PORT} (Next.js + relay on /relay)`);
});
