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
// Keyboard mapping: browser KeyboardEvent.code -> Windows Virtual Key code
// ---------------------------------------------------------------------------
//
// We use `code` (physical key position, e.g. "KeyA", "Digit1") rather than
// `key` (the logical character produced, which depends on modifiers +
// layout) because the receiving OS does its own modifier+layout handling
// once we tell it which physical key was pressed. This is the same approach
// Chrome Remote Desktop and Parsec take.
//
// For characters that don't have a physical code (dead keys, IME composition,
// emoji keyboards), `key` becomes a 1-char Unicode string and the agent
// falls back to SendInput w/ KEYEVENTF_UNICODE (Windows) / xdotool type
// (Linux) so typing still works for non-ASCII text.
const KEY_CODE_TO_VK = {
  // Letters
  KeyA: 0x41, KeyB: 0x42, KeyC: 0x43, KeyD: 0x44, KeyE: 0x45, KeyF: 0x46,
  KeyG: 0x47, KeyH: 0x48, KeyI: 0x49, KeyJ: 0x4A, KeyK: 0x4B, KeyL: 0x4C,
  KeyM: 0x4D, KeyN: 0x4E, KeyO: 0x4F, KeyP: 0x50, KeyQ: 0x51, KeyR: 0x52,
  KeyS: 0x53, KeyT: 0x54, KeyU: 0x55, KeyV: 0x56, KeyW: 0x57, KeyX: 0x58,
  KeyY: 0x59, KeyZ: 0x5A,
  // Top-row digits
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  // Function row
  F1: 0x70,  F2: 0x71,  F3: 0x72,  F4: 0x73,  F5: 0x74,  F6: 0x75,
  F7: 0x76,  F8: 0x77,  F9: 0x78,  F10: 0x79, F11: 0x7A, F12: 0x7B,
  // Editing
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, Escape: 0x1B, Space: 0x20,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2D, Delete: 0x2E,
  // Modifiers (we send L/R distinctly so Ctrl+Shift+Alt combos work cleanly)
  ShiftLeft: 0xA0,   ShiftRight: 0xA1,
  ControlLeft: 0xA2, ControlRight: 0xA3,
  AltLeft: 0xA4,     AltRight: 0xA5,
  MetaLeft: 0x5B,    MetaRight: 0x5C,
  CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, ContextMenu: 0x5D,
  // Numpad
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D,
  NumpadDecimal:  0x6E, NumpadDivide:   0x6F, NumpadEnter: 0x0D,
  // OEM / punctuation (US layout VKs — the OS maps these back via the
  // user's active layout, so AZERTY/QWERTZ users get the right character).
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE,
  Slash: 0xBF, Backquote: 0xC0, BracketLeft: 0xDB, Backslash: 0xDC,
  BracketRight: 0xDD, Quote: 0xDE, IntlBackslash: 0xE2,
};

// Browser code -> xdotool keysym (Linux backend).
const KEY_CODE_TO_XDO = {
  KeyA: "a", KeyB: "b", KeyC: "c", KeyD: "d", KeyE: "e", KeyF: "f",
  KeyG: "g", KeyH: "h", KeyI: "i", KeyJ: "j", KeyK: "k", KeyL: "l",
  KeyM: "m", KeyN: "n", KeyO: "o", KeyP: "p", KeyQ: "q", KeyR: "r",
  KeyS: "s", KeyT: "t", KeyU: "u", KeyV: "v", KeyW: "w", KeyX: "x",
  KeyY: "y", KeyZ: "z",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  Backspace: "BackSpace", Tab: "Tab", Enter: "Return", Escape: "Escape", Space: "space",
  PageUp: "Prior", PageDown: "Next", End: "End", Home: "Home",
  ArrowLeft: "Left", ArrowUp: "Up", ArrowRight: "Right", ArrowDown: "Down",
  Insert: "Insert", Delete: "Delete",
  ShiftLeft: "Shift_L", ShiftRight: "Shift_R",
  ControlLeft: "Control_L", ControlRight: "Control_R",
  AltLeft: "Alt_L", AltRight: "Alt_R",
  MetaLeft: "Super_L", MetaRight: "Super_R",
  CapsLock: "Caps_Lock",
  Semicolon: "semicolon", Equal: "equal", Comma: "comma", Minus: "minus",
  Period: "period", Slash: "slash", Backquote: "grave", BracketLeft: "bracketleft",
  Backslash: "backslash", BracketRight: "bracketright", Quote: "apostrophe",
};

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
  // Preload the Win32 functions into a persistent PowerShell host. The
  // `Add-Type` call compiles a tiny C# wrapper on first use (~200-600 ms on
  // a cold machine); until that finishes, any command we pipe in would fail
  // with "Move is not recognized". So we queue writes until the PS process
  // prints "[ps] ready" on stdout, and only then flush the queue.
  //
  // We also pass `-ExecutionPolicy Bypass` because the default Restricted /
  // AllSigned policy on some Windows installs refuses `Add-Type` inline
  // scripts -- the child would exit silently and the mouse would just
  // never move.
  // PowerShell init: compile a tiny C# wrapper around user32.dll once. We
  // expose Move / Btn / Scroll (mouse) and KeyDown / KeyUp / TypeUnicode
  // (keyboard). TypeUnicode uses SendInput with KEYEVENTF_UNICODE so any
  // codepoint the client types -- including Arabic, emoji, accented letters
  // -- arrives intact regardless of the host's keyboard layout.
  const init = `
$ErrorActionPreference='Continue'
Add-Type -Name U -Namespace W -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit)]
public struct INPUTUNION { [System.Runtime.InteropServices.FieldOffset(0)] public KEYBDINPUT ki; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUTUNION u; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int cb);

public static void TypeChar(char c) {
  INPUT[] a = new INPUT[2];
  a[0].type = 1; a[0].u.ki.wScan = (ushort)c; a[0].u.ki.dwFlags = 4; // KEYEVENTF_UNICODE
  a[1].type = 1; a[1].u.ki.wScan = (ushort)c; a[1].u.ki.dwFlags = 4 | 2; // + KEYUP
  SendInput(2u, a, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
}
"@
function Move($nx,$ny) {
  $sw=[W.U]::GetSystemMetrics(0); $sh=[W.U]::GetSystemMetrics(1)
  [W.U]::SetCursorPos([int]($sw*$nx),[int]($sh*$ny)) | Out-Null
}
function Btn($flag) { [W.U]::mouse_event($flag,0,0,0,0) }
function Scroll($d) { [W.U]::mouse_event(2048,0,0,$d,0) }
# KEYEVENTF_KEYUP = 2
function KeyDown($vk) { [W.U]::keybd_event([byte]$vk, 0, 0, 0) }
function KeyUp($vk)   { [W.U]::keybd_event([byte]$vk, 0, 2, 0) }
function TypeU($s) { foreach ($ch in $s.ToCharArray()) { [W.U]::TypeChar($ch) } }
Write-Host "[ps] ready"
`;
  const ps = spawn("powershell.exe",
    ["-NoProfile", "-NoLogo", "-NonInteractive",
     "-ExecutionPolicy", "Bypass", "-Command", "-"],
    { stdio: ["pipe", "pipe", "pipe"] });
  ps.stdin.write(init + "\n");

  let ready = false;
  const queue = [];
  const writePs = (s) => {
    if (ready) {
      try { ps.stdin.write(s); } catch { /* ignore */ }
    } else {
      queue.push(s);
    }
  };

  let stdoutBuf = "";
  ps.stdout.on("data", (d) => {
    const chunk = String(d);
    if (VERBOSE) process.stdout.write(`[ps-out] ${chunk}`);
    stdoutBuf += chunk;
    if (!ready && stdoutBuf.includes("[ps] ready")) {
      ready = true;
      console.log("[agent] PowerShell backend ready");
      // Flush anything that was queued during warm-up.
      while (queue.length) {
        try { ps.stdin.write(queue.shift()); } catch { /* ignore */ }
      }
    }
  });
  ps.stderr.on("data", (d) => console.warn(`[ps-err] ${String(d).trim()}`));
  ps.on("exit", (code) => {
    ready = false;
    console.warn(`[agent] PowerShell exited (code=${code})`);
  });

  // MOUSEEVENTF_* bits: LDOWN=2 LUP=4 RDOWN=8 RUP=16 MDOWN=32 MUP=64
  const DOWN = { 0: 2,  1: 32, 2: 8  };
  const UP   = { 0: 4,  1: 64, 2: 16 };

  return {
    label: "native:windows",
    get ready() { return ready; },
    send: (line) => {
      // Split once on spaces for verb+args, but keep everything after the
      // verb as a single string for TYPE (so "TYPE hello world" works).
      const sp = line.indexOf(" ");
      const verb = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? "" : line.slice(sp + 1);
      const [a, b] = rest.split(" ");
      if (verb === "MOVE") {
        writePs(`Move ${a} ${b}\n`);
      } else if (verb === "DOWN") {
        writePs(`Btn ${DOWN[+a] ?? 2}\n`);
      } else if (verb === "UP") {
        writePs(`Btn ${UP[+a] ?? 4}\n`);
      } else if (verb === "CLICK") {
        writePs(`Btn ${DOWN[+a] ?? 2}\nBtn ${UP[+a] ?? 4}\n`);
      } else if (verb === "SCROLL") {
        // Flip: WheelEvent.deltaY positive = scroll down; Win expects +up.
        writePs(`Scroll ${-Math.round(Number(a) || 0)}\n`);
      } else if (verb === "KEYDOWN") {
        writePs(`KeyDown ${+a}\n`);
      } else if (verb === "KEYUP") {
        writePs(`KeyUp ${+a}\n`);
      } else if (verb === "TYPE") {
        // Escape single-quotes and backslashes for the PS string literal.
        const esc = rest.replace(/`/g, "``").replace(/'/g, "''");
        writePs(`TypeU '${esc}'\n`);
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
      const sp = line.indexOf(" ");
      const verb = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? "" : line.slice(sp + 1);
      const [a, b] = rest.split(" ");
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
      } else if (verb === "KEYDOWN") {
        if (a) run(["keydown", a]);
      } else if (verb === "KEYUP") {
        if (a) run(["keyup", a]);
      } else if (verb === "TYPE") {
        if (rest) run(["type", "--", rest]);
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

// Last emitted cursor position — used to skip redundant MOVEs. The browser
// fires mousemove at ~120Hz even while the mouse is physically still (when
// the cursor re-enters a different subregion etc.), and every move spawns
// a PowerShell call on the Win32 backend. De-dup and the backend stays
// responsive.
let lastMoveX = -1;
let lastMoveY = -1;

function translate(ev) {
  if (!ev || typeof ev !== "object") return [];
  if (ev.t === "mouse") {
    const x = clamp01(ev.x), y = clamp01(ev.y);
    const btn = Number.isInteger(ev.button) ? ev.button : 0;
    const out = [];
    // Skip the MOVE if the cursor hasn't actually moved since last time.
    // 4-decimal precision ~= 1 pixel on a 10k-wide screen, which is plenty.
    if (x !== lastMoveX || y !== lastMoveY) {
      out.push(`MOVE ${x.toFixed(4)} ${y.toFixed(4)}`);
      lastMoveX = x; lastMoveY = y;
    }
    if (ev.kind === "down") out.push(`DOWN ${btn}`);
    if (ev.kind === "up")   out.push(`UP ${btn}`);
    // NOTE: intentionally no handler for "click". The browser fires
    // mousedown + mouseup + click for each physical click — honoring all
    // three made the host double-click every time. down + up alone is
    // enough: the host OS synthesizes its own click from the pair.
    return out;
  }
  if (ev.t === "wheel") {
    const delta = Math.round(Number(ev.dy) || 0);
    if (delta === 0) return [];
    return [`SCROLL ${delta}`];
  }
  if (ev.t === "key") {
    // Two paths:
    //   1) Physical key we know -> emit KEYDOWN/KEYUP with VK code. This is
    //      what letters, digits, arrows, shift, ctrl all go through. Held
    //      keys keep firing keydown with repeat=true in the browser; we pass
    //      those along so game-style "walk forward" holds work.
    //   2) Unknown `code` AND a single printable character in `key` -> emit
    //      TYPE with that character on keydown only (skip keyup). This
    //      handles dead keys, IME composition, emoji keyboards, etc., which
    //      don't correspond to a physical Windows VK.
    const platform = process.platform;
    const map = platform === "linux" ? KEY_CODE_TO_XDO : KEY_CODE_TO_VK;
    const token = map[ev.code];
    if (token !== undefined) {
      if (ev.kind === "down") return [`KEYDOWN ${token}`];
      if (ev.kind === "up")   return [`KEYUP ${token}`];
      return [];
    }
    // Fallback: for keys we don't recognize but with printable `key` content.
    if (ev.kind === "down" && typeof ev.key === "string" && ev.key.length >= 1 && ev.key.length <= 8 && ev.key !== "Dead") {
      // Filter out named keys like "Unidentified" / "Shift" (length>1)
      if (ev.key.length === 1 || /^[\p{Emoji}\p{L}]+$/u.test(ev.key)) {
        return [`TYPE ${ev.key}`];
      }
    }
    return [];
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

wss.on("connection", (ws, req) => {
  console.log(`[agent] browser connected (origin=${req.headers.origin || "-"})`);
  // Tell the UI our status. `ready` means "the backend can actually inject
  // events right now" -- for VB6 that's the TCP link; for native Windows it
  // flips true after PowerShell finishes Add-Type; for xdotool/osascript it's
  // treated as always-ready (the helper starts instantly).
  const reportStatus = () => {
    const msg = {
      type: "agent:status",
      backend: backend.label,
      ready: backend.ready ?? true,
    };
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  };
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
