// agent.js -- local bridge between the browser Host page and the host's
// operating system. This process runs on the person whose screen is being
// shared (never on Render).
//
//   browser Host page  ----ws://127.0.0.1:8766---->  this agent  --->  OS mouse
//
// Two backends, picked automatically:
//
//   "native" (default)   Uses whatever input tool the OS ships with:
//                          - Windows  -> PowerShell invoking user32.dll
//                                        (SetCursorPos / mouse_event), same
//                                        APIs the VB6 program uses.
//                          - macOS    -> osascript (Cocoa events).
//                          - Linux    -> xdotool (must be installed).
//   "vb6"                 Forwards the line protocol over TCP to
//                          MouseControl.exe on 127.0.0.1:8765. Useful if you
//                          prefer a standalone GUI-visible agent.
//
// Force a backend with BACKEND=native | BACKEND=vb6; default: native.
//
// Security: browsers include an Origin header on WebSocket upgrades. We lock
// the agent to a single Origin via the ALLOWED_ORIGIN env var, e.g.
//
//   ALLOWED_ORIGIN=https://my-app.onrender.com npm start
//
// If ALLOWED_ORIGIN is unset we default to "only accept browsers whose
// Origin is itself a loopback page" -- the same address space as us.

import net from "node:net";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const VB6_HOST = "127.0.0.1";
const VB6_PORT = 8765;
const WS_HOST  = "127.0.0.1";
const WS_PORT  = 8766;

const BACKEND        = (process.env.BACKEND || "native").toLowerCase();
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // "" = loopback-only
const VERBOSE        = process.env.VERBOSE === "1";

// ---------------------------------------------------------------------------
// Origin check
// ---------------------------------------------------------------------------
//
// Returning true means "this WebSocket client is allowed to drive my mouse".
// There are two permitted cases:
//   (1) ALLOWED_ORIGIN is explicitly set and matches the request's Origin.
//       Typical production: set it to your Render URL.
//   (2) ALLOWED_ORIGIN is empty AND the Origin is a loopback page (file://,
//       http(s)://localhost, http(s)://127.0.0.1). This covers dev usage.
//
// Anything else is dropped with a 403. Combined with the 127.0.0.1 bind
// below, it means: even another browser tab open on the same machine can't
// make the agent move your mouse unless it came from a page whose Origin
// matches the allowlist.
function isAllowedOrigin(origin) {
  if (!origin) return ALLOWED_ORIGIN === "" ? true : false;
  if (ALLOWED_ORIGIN) return origin === ALLOWED_ORIGIN;
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Backend: native (PowerShell / xdotool / osascript)
// ---------------------------------------------------------------------------
//
// We keep one long-lived child process and feed it commands over stdin,
// because spawning a fresh PowerShell per mousemove would be unusably slow
// (~500 ms per click).

function createNativeBackend() {
  if (process.platform === "win32") return createWindowsBackend();
  if (process.platform === "linux") return createLinuxBackend();
  if (process.platform === "darwin") return createMacBackend();
  console.warn(`[agent] native backend unsupported on ${process.platform}`);
  return null;
}

function createWindowsBackend() {
  // Preload the Win32 functions into a persistent PowerShell host.
  const init = `
$ErrorActionPreference='Continue'
Add-Type -Name U -Namespace W -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
"@
function Move($nx,$ny) {
  $sw=[W.U]::GetSystemMetrics(0); $sh=[W.U]::GetSystemMetrics(1)
  [W.U]::SetCursorPos([int]($sw*$nx),[int]($sh*$ny)) | Out-Null
}
function Btn($flag) { [W.U]::mouse_event($flag,0,0,0,0) }
function Scroll($d) { [W.U]::mouse_event(2048,0,0,$d,0) }
Write-Host "[ps] ready"
`;
  const ps = spawn("powershell.exe",
    ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "-"],
    { stdio: ["pipe", "pipe", "pipe"] });
  ps.stdin.write(init + "\n");
  ps.stdout.on("data", (d) => VERBOSE && process.stdout.write(`[ps-out] ${d}`));
  ps.stderr.on("data", (d) => console.warn(`[ps-err] ${String(d).trim()}`));
  ps.on("exit", (code) => console.warn(`[agent] PowerShell exited (code=${code})`));

  // MOUSEEVENTF_* bits: LDOWN=2 LUP=4 RDOWN=8 RUP=16 MDOWN=32 MUP=64
  const DOWN = { 0: 2,  1: 32, 2: 8  };
  const UP   = { 0: 4,  1: 64, 2: 16 };

  return {
    label: "native:windows",
    send: (line) => {
      const [verb, a, b] = line.split(" ");
      if (verb === "MOVE") {
        ps.stdin.write(`Move ${a} ${b}\n`);
      } else if (verb === "DOWN") {
        ps.stdin.write(`Btn ${DOWN[+a] ?? 2}\n`);
      } else if (verb === "UP") {
        ps.stdin.write(`Btn ${UP[+a] ?? 4}\n`);
      } else if (verb === "CLICK") {
        ps.stdin.write(`Btn ${DOWN[+a] ?? 2}\nBtn ${UP[+a] ?? 4}\n`);
      } else if (verb === "SCROLL") {
        // Flip: WheelEvent.deltaY positive = scroll down; Win expects +up.
        ps.stdin.write(`Scroll ${-Math.round(Number(a) || 0)}\n`);
      }
    },
    close: () => { try { ps.kill(); } catch { /* ignore */ } },
  };
}

function createLinuxBackend() {
  // xdotool absolute MOVE uses screen pixels. We don't cache the size; a
  // single `xdotool getdisplaygeometry` adds ~5 ms once.
  let screen = { w: 1920, h: 1080 };
  try {
    const r = spawn("xdotool", ["getdisplaygeometry"]);
    r.stdout.on("data", (d) => {
      const [w, h] = String(d).trim().split(" ").map((n) => parseInt(n, 10));
      if (w && h) screen = { w, h };
    });
  } catch (e) {
    console.warn("[agent] couldn't query screen size; assuming 1920x1080");
  }

  const run = (args) => { try { spawn("xdotool", args); } catch { /* ignore */ } };
  const BTN = { 0: "1", 1: "2", 2: "3" };

  return {
    label: "native:linux",
    send: (line) => {
      const [verb, a, b] = line.split(" ");
      if (verb === "MOVE") {
        run(["mousemove", String(Math.round(Number(a) * screen.w)), String(Math.round(Number(b) * screen.h))]);
      } else if (verb === "DOWN") {
        run(["mousedown", BTN[+a] ?? "1"]);
      } else if (verb === "UP") {
        run(["mouseup", BTN[+a] ?? "1"]);
      } else if (verb === "CLICK") {
        run(["click", BTN[+a] ?? "1"]);
      } else if (verb === "SCROLL") {
        const d = Number(a) || 0;
        // xdotool uses buttons 4/5 for scroll wheel up/down.
        run(["click", d < 0 ? "4" : "5"]);
      }
    },
    close: () => { /* nothing persistent */ },
  };
}

function createMacBackend() {
  // AppleScript doesn't ship a mouse mover, but it's available via osascript
  // after enabling Accessibility for Terminal/node. We use a tiny JXA helper.
  const helper = `
ObjC.import("CoreGraphics");
ObjC.import("Foundation");
function move(nx, ny) {
  var screen = $.NSScreen.mainScreen.frame;
  var p = $.CGPointMake(nx * screen.size.width, ny * screen.size.height);
  $.CGWarpMouseCursorPosition(p); $.CGAssociateMouseAndMouseCursorPosition(true);
}
function btn(kind, which) {
  var pos = $.CGEventGetLocation($.CGEventCreate(null));
  var types = {lu:1, ld:2, rd:3, ru:4, mu:26, md:25, lc:2, rc:3, mc:25};
  // 'c' = click: we emit down+up
  if (kind === "c") { btn("d", which); btn("u", which); return; }
  var t = types[(kind + which) ] || 2;
  var e = $.CGEventCreateMouseEvent(null, t, pos,
     which === "l" ? 0 : (which === "r" ? 1 : 2));
  $.CGEventPost(0, e);
}
function readLoop() {
  var input = $.NSFileHandle.fileHandleWithStandardInput;
  while (true) {
    var d = input.availableData;
    if (!d.length) break;
    var s = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding));
    s.split("\\n").filter(Boolean).forEach(function(line){
      var p = line.split(" ");
      if (p[0] === "MOVE") move(+p[1], +p[2]);
      else if (p[0] === "DOWN")  btn("d", ["l","m","r"][+p[1]] || "l");
      else if (p[0] === "UP")    btn("u", ["l","m","r"][+p[1]] || "l");
      else if (p[0] === "CLICK") btn("c", ["l","m","r"][+p[1]] || "l");
    });
  }
}
readLoop();
`;
  const jx = spawn("osascript", ["-l", "JavaScript", "-e", helper], { stdio: ["pipe", "pipe", "pipe"] });
  jx.stderr.on("data", (d) => console.warn(`[osa-err] ${String(d).trim()}`));
  jx.on("exit", (code) => console.warn(`[agent] osascript exited (code=${code})`));

  return {
    label: "native:macos",
    send: (line) => { try { jx.stdin.write(line + "\n"); } catch { /* ignore */ } },
    close: () => { try { jx.kill(); } catch { /* ignore */ } },
  };
}

// ---------------------------------------------------------------------------
// Backend: vb6 (legacy TCP to MouseControl.exe)
// ---------------------------------------------------------------------------

function createVB6Backend() {
  let tcp = null;
  let ready = false;
  let reconnectTimer = null;

  const connect = () => {
    tcp = net.createConnection({ host: VB6_HOST, port: VB6_PORT }, () => {
      ready = true;
      console.log(`[agent] connected to VB6 at ${VB6_HOST}:${VB6_PORT}`);
    });
    tcp.setNoDelay(true);
    tcp.on("data", (buf) => VERBOSE && console.log(`[vb6] ${buf}`));
    const onClosed = () => {
      ready = false; tcp = null;
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
    };
    tcp.on("close", onClosed);
    tcp.on("error", (err) => { if (err.code !== "ECONNREFUSED") console.warn(`[agent] VB6 error: ${err.message}`); try { tcp?.destroy(); } catch {} onClosed(); });
  };
  connect();

  return {
    label: "vb6",
    get ready() { return ready; },
    send: (line) => { try { if (ready) tcp.write(line + "\n"); } catch { /* ignore */ } },
    close: () => { try { tcp?.destroy(); } catch { /* ignore */ } },
  };
}

// ---------------------------------------------------------------------------
// Pick the backend once, on boot
// ---------------------------------------------------------------------------

const backend = BACKEND === "vb6" ? createVB6Backend() : createNativeBackend();

if (!backend) {
  console.error("[agent] no injection backend available on this platform; exiting.");
  process.exit(1);
}

console.log(`[agent] backend: ${backend.label}`);

// ---------------------------------------------------------------------------
// Event translator -- same wire format as before.
// ---------------------------------------------------------------------------

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function translate(ev) {
  if (!ev || typeof ev !== "object") return [];
  if (ev.t === "mouse") {
    const x = clamp01(ev.x), y = clamp01(ev.y);
    const btn = Number.isInteger(ev.button) ? ev.button : 0;
    const out = [`MOVE ${x.toFixed(4)} ${y.toFixed(4)}`];
    if (ev.kind === "down")  out.push(`DOWN ${btn}`);
    if (ev.kind === "up")    out.push(`UP ${btn}`);
    if (ev.kind === "click") out.push(`CLICK ${btn}`);
    return out;
  }
  if (ev.t === "wheel") {
    const delta = Math.round(Number(ev.dy) || 0);
    if (delta === 0) return [];
    return [`SCROLL ${delta}`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// WebSocket server for the browser Host page
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({
  host: WS_HOST,
  port: WS_PORT,
  verifyClient: ({ origin, req }, done) => {
    if (!isAllowedOrigin(origin)) {
      console.warn(`[agent] rejecting connection: Origin=${origin || "(none)"} not allowed`);
      return done(false, 403, "Origin not allowed");
    }
    // Belt-and-braces: only accept loopback callers, regardless of Origin.
    const ip = req.socket.remoteAddress;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      console.warn(`[agent] rejecting non-loopback caller ${ip}`);
      return done(false, 403, "Loopback only");
    }
    done(true);
  },
});

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

wss.on("connection", (ws, req) => {
  console.log(`[agent] browser connected (origin=${req.headers.origin || "-"})`);
  // Tell the UI we're alive. "connected: true" just means "agent can inject";
  // for the native backend that's always true. For VB6 it tracks the TCP link.
  const reportStatus = () => ws.send(JSON.stringify({ type: "agent:vb6", connected: backend.ready ?? true }));
  reportStatus();
  const statusTimer = setInterval(reportStatus, 2000);

  ws.on("message", (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString("utf8")); } catch { return; }
    for (const line of translate(ev)) backend.send(line);
  });

  ws.on("close", () => {
    clearInterval(statusTimer);
    console.log("[agent] browser disconnected");
  });
});

wss.on("listening", () => {
  console.log(`[agent] WebSocket ready at ws://${WS_HOST}:${WS_PORT}`);
  console.log(`[agent] Origin allowlist: ${ALLOWED_ORIGIN || "(loopback pages only)"}`);
});

process.on("SIGINT", () => {
  console.log("\n[agent] shutting down");
  try { backend.close(); } catch { /* ignore */ }
  wss.close();
  process.exit(0);
});
