import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { TAG_CONTROL, type ControlMessage, type PublicDevice } from "@rc/protocol";

const PORT = Number(process.env.PORT ?? 4000);

/** Extra fields we attach to a ws for the ping-pong keepalive watchdog. */
type AliveWs = WebSocket & { isAlive?: boolean };

interface DeviceEntry {
  deviceId:   string;
  deviceName: string;
  pin:        string;
  hostWs:     WebSocket;
  controller: { ws: WebSocket; name: string } | null;
}

const devices = new Map<string, DeviceEntry>();

const PING_INTERVAL_MS = 30_000;

// ─── Framing helpers ──────────────────────────────────────────────────────────

function sendControl(ws: WebSocket, msg: ControlMessage): void {
  try {
    const json = Buffer.from(JSON.stringify(msg), "utf8");
    const framed = Buffer.concat([Buffer.from([TAG_CONTROL]), json]);
    ws.send(framed, { binary: true });
  } catch { /* socket already closed — ignore */ }
}

function parseControl(data: Buffer): ControlMessage | null {
  if (data.length < 2 || data[0] !== TAG_CONTROL) return null;
  try {
    return JSON.parse(data.subarray(1).toString("utf8")) as ControlMessage;
  } catch {
    return null;
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // Public device list — never includes the PIN.
  if (req.url === "/devices" && req.method === "GET") {
    const list: PublicDevice[] = [];
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

  res.writeHead(404).end();
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

type JoinedAs =
  | { role: "host";       deviceId: string }
  | { role: "controller"; deviceId: string };

wss.on("connection", (rawWs) => {
  const ws = rawWs as AliveWs;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  let joined: JoinedAs | null = null;

  ws.on("message", (raw: Buffer) => {
    if (!joined) {
      const msg = parseControl(raw);
      if (!msg) {
        sendControl(ws, { type: "error", reason: "expected control frame" });
        ws.close();
        return;
      }

      if (msg.type === "register-host") {
        // Newest-wins: if a prior socket is still tracked for this device,
        // boot it — it's almost certainly a half-open leftover from a flaky
        // proxy path (Render/Cloudflare idle-reap → host reconnects before
        // we've noticed the old socket died).
        const existing = devices.get(msg.deviceId);
        if (existing && existing.hostWs !== ws) {
          console.log(`[relay] replacing stale host registration for "${existing.deviceName}" (${msg.deviceId.slice(0, 8)}…)`);
          try { existing.hostWs.terminate(); } catch { /* ignore */ }
          if (existing.controller?.ws.readyState === 1) {
            sendControl(existing.controller.ws, { type: "peer-left", role: "host" });
          }
          devices.delete(msg.deviceId);
        }

        const entry: DeviceEntry = {
          deviceId:   msg.deviceId,
          deviceName: msg.deviceName,
          pin:        msg.pin,
          hostWs:     ws,
          controller: null,
        };
        devices.set(msg.deviceId, entry);
        joined = { role: "host", deviceId: msg.deviceId };
        sendControl(ws, { type: "host-registered" });
        console.log(`[relay] host "${msg.deviceName}" registered (${msg.deviceId.slice(0, 8)}…)`);
        return;
      }

      if (msg.type === "connect-controller") {
        const entry = devices.get(msg.deviceId);
        if (!entry || entry.hostWs.readyState !== 1) {
          sendControl(ws, { type: "error", reason: "device not online" });
          ws.close();
          return;
        }
        if (entry.pin !== msg.pin) {
          sendControl(ws, { type: "error", reason: "incorrect PIN" });
          ws.close();
          return;
        }
        if (entry.controller && entry.controller.ws.readyState <= 1) {
          sendControl(ws, { type: "error", reason: "device is busy" });
          ws.close();
          return;
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

    const entry = devices.get(joined.deviceId);
    if (!entry) return;
    const target = joined.role === "controller" ? entry.hostWs : entry.controller?.ws;
    if (target && target.readyState === 1) {
      target.send(raw, { binary: true });
    }
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

// Server-side keepalive — detect & reap half-dead clients.
const pingInterval = setInterval(() => {
  for (const rawWs of wss.clients) {
    const ws = rawWs as AliveWs;
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* 'close' will handle it */ }
  }
}, PING_INTERVAL_MS);
wss.on("close", () => clearInterval(pingInterval));

httpServer.listen(PORT, () => {
  console.log(`[relay] listening on ws://localhost:${PORT}`);
});
