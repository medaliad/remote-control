// agent.js -- local bridge between the browser Host page and the VB6 mouse agent.
//
// The browser talks to us over ws://127.0.0.1:8766 (JSON InputEvents).
// We hold a single persistent TCP connection to the VB6 listener on
// 127.0.0.1:8765, and translate each JSON event into the newline-delimited
// text protocol the VB6 form understands:
//
//   { t: "mouse", x, y, kind: "move" }           -> "MOVE 0.412 0.883\n"
//   { t: "mouse", x, y, button, kind: "down" }   -> "DOWN 0\n"  (plus a MOVE first)
//   { t: "wheel", dy }                           -> "SCROLL 120\n"
//
// Why this layer exists at all: browsers can't open raw TCP, and VB6's
// Winsock control doesn't speak WebSocket framing. Bridging in 80 lines of
// Node is simpler than trying to teach either side the other's protocol.

import net from "node:net";
import { WebSocketServer } from "ws";

const VB6_HOST = "127.0.0.1";
const VB6_PORT = 8765;
const WS_HOST  = "127.0.0.1";
const WS_PORT  = 8766;

// ---- VB6 TCP connection, with auto-reconnect -------------------------------

let tcp = null;
let tcpReady = false;
let reconnectTimer = null;

function connectToVB6() {
  tcpReady = false;
  tcp = net.createConnection({ host: VB6_HOST, port: VB6_PORT }, () => {
    tcpReady = true;
    console.log(`[agent] connected to VB6 at ${VB6_HOST}:${VB6_PORT}`);
    broadcast({ type: "agent:vb6", connected: true });
  });

  tcp.setNoDelay(true);

  tcp.on("data", (buf) => {
    // We don't do anything with replies beyond logging -- the browser's
    // "did the mouse move?" feedback is visual, via the WebRTC stream.
    const text = buf.toString("utf8").trim();
    if (text) console.log(`[vb6] ${text}`);
  });

  const onClosed = (why) => {
    if (tcpReady) console.log(`[agent] VB6 connection ${why}`);
    tcpReady = false;
    tcp = null;
    broadcast({ type: "agent:vb6", connected: false });
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToVB6();
      }, 1500);
    }
  };
  tcp.on("close", () => onClosed("closed"));
  tcp.on("error", (err) => {
    // ECONNREFUSED is normal until the user launches the VB6 program; don't
    // shout about it every time.
    if (err.code !== "ECONNREFUSED") {
      console.warn(`[agent] VB6 socket error: ${err.message}`);
    }
    try { tcp?.destroy(); } catch { /* ignore */ }
    onClosed("errored");
  });
}

function sendToVB6(line) {
  if (!tcpReady || !tcp) return false;
  try {
    tcp.write(line + "\n");
    return true;
  } catch (err) {
    console.warn(`[agent] write failed: ${err.message}`);
    return false;
  }
}

// ---- Translate one browser event into zero-or-more VB6 commands ------------

function translate(ev) {
  if (!ev || typeof ev !== "object") return [];

  if (ev.t === "mouse") {
    const x = clamp01(ev.x);
    const y = clamp01(ev.y);
    const btn = Number.isInteger(ev.button) ? ev.button : 0;
    // Always emit a MOVE first, then the button action at that coordinate.
    // The browser reports coordinates with the event anyway, so this keeps
    // click-at-point accurate even if an intermediate mousemove was dropped.
    const out = [`MOVE ${x.toFixed(4)} ${y.toFixed(4)}`];
    if (ev.kind === "down")  out.push(`DOWN ${btn}`);
    if (ev.kind === "up")    out.push(`UP ${btn}`);
    if (ev.kind === "click") out.push(`CLICK ${btn}`);
    return out;
  }

  if (ev.t === "wheel") {
    // We collapse to vertical scroll for now; VB6 side only has WHEEL.
    const delta = Math.round(Number(ev.dy) || 0);
    if (delta === 0) return [];
    return [`SCROLL ${delta}`];
  }

  // Keys are intentionally unsupported here -- VB6's keybd_event would be
  // the analog; left as a TODO so mouse control can ship first.
  return [];
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// ---- WebSocket server (for the browser Host page) --------------------------

const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT });

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  // Loopback only -- the listener is already bound to 127.0.0.1 but an extra
  // guard never hurts when we're about to move the user's mouse.
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
    console.warn(`[agent] rejecting non-loopback client ${ip}`);
    ws.close(1008, "loopback only");
    return;
  }

  console.log(`[agent] browser connected (${ip})`);
  ws.send(JSON.stringify({ type: "agent:vb6", connected: tcpReady }));

  ws.on("message", (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString("utf8")); }
    catch { return; }

    const lines = translate(ev);
    for (const line of lines) sendToVB6(line);
  });

  ws.on("close", () => console.log(`[agent] browser disconnected (${ip})`));
});

wss.on("listening", () => {
  console.log(`[agent] WebSocket ready at ws://${WS_HOST}:${WS_PORT}`);
});

// ---- go! -------------------------------------------------------------------

connectToVB6();

process.on("SIGINT", () => {
  console.log("\n[agent] shutting down");
  try { tcp?.destroy(); } catch { /* ignore */ }
  wss.close();
  process.exit(0);
});
