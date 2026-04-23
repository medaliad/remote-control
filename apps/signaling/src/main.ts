import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { TAG_CONTROL, type ControlMessage, type PublicDevice } from "@rc/protocol";

const PORT = Number(process.env.PORT ?? 4000);

/**
 * One entry per online host. `deviceId` is the stable key — it survives host
 * restarts. `pin` is regenerated every time the host process starts and is
 * never exposed over HTTP.
 */
interface DeviceEntry {
  deviceId:   string;
  deviceName: string;
  pin:        string;
  hostWs:     WebSocket;
  controller: { ws: WebSocket; name: string } | null;
}

const devices = new Map<string, DeviceEntry>();

// ─── Framing helpers ──────────────────────────────────────────────────────────

function sendControl(ws: WebSocket, msg: ControlMessage): void {
  const json = Buffer.from(JSON.stringify(msg), "utf8");
  const framed = Buffer.concat([Buffer.from([TAG_CONTROL]), json]);
  ws.send(framed, { binary: true });
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

wss.on("connection", (ws) => {
  let joined: JoinedAs | null = null;

  ws.on("message", (raw: Buffer) => {
    // First message must register/connect.
    if (!joined) {
      const msg = parseControl(raw);
      if (!msg) {
        sendControl(ws, { type: "error", reason: "expected control frame" });
        ws.close();
        return;
      }

      if (msg.type === "register-host") {
        const existing = devices.get(msg.deviceId);
        if (existing && existing.hostWs.readyState <= 1 /* CONNECTING | OPEN */) {
          sendControl(ws, { type: "error", reason: "device already online" });
          ws.close();
          return;
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
        if (!entry || entry.hostWs.readyState !== 1 /* OPEN */) {
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

        // Cross-notify both peers.
        sendControl(entry.hostWs, { type: "peer-joined", role: "controller", name });
        sendControl(ws,           { type: "peer-joined", role: "host",       name: entry.deviceName });
        console.log(`[relay] controller "${name}" paired with "${entry.deviceName}"`);
        return;
      }

      sendControl(ws, { type: "error", reason: "must register-host or connect-controller first" });
      ws.close();
      return;
    }

    // Already paired — forward bytes to the peer.
    const entry = devices.get(joined.deviceId);
    if (!entry) return;
    const target = joined.role === "controller" ? entry.hostWs : entry.controller?.ws;
    if (target && target.readyState === 1 /* OPEN */) {
      target.send(raw, { binary: true });
    }
  });

  ws.on("close", () => {
    if (!joined) return;
    const entry = devices.get(joined.deviceId);
    if (!entry) return;

    if (joined.role === "host" && entry.hostWs === ws) {
      // Host dropped — the whole device is offline. Notify controller and drop.
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

httpServer.listen(PORT, () => {
  console.log(`[relay] listening on ws://localhost:${PORT}`);
});
