import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";
const VB6_HOST = "127.0.0.1";
const VB6_PORT = 8765;
const WS_HOST = "127.0.0.1";
const WS_PORT = 8766;
const PROGRAM_NAME = "VEAdminAgent";
const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const VB6_RECONNECT_DELAY_MS = 1500;
const AGENT_HEARTBEAT_INTERVAL_MS = 25_000;
function userDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), PROGRAM_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", PROGRAM_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), PROGRAM_NAME);
}
const CONFIG_DIR = userDataDir();
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
const SCRIPT_CONFIG_PATH = path.join(SCRIPT_DIR, "config.json");
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.warn(`[config] couldn't parse ${filePath}: ${err.message}`);
    }
    return null;
  }
}
const fileConfig = readJsonFile(SCRIPT_CONFIG_PATH) ?? readJsonFile(CONFIG_PATH) ?? {};
function pick(envName, configKey, fallback = "") {
  const fromEnv = process.env[envName];
  if (fromEnv != null && fromEnv !== "") return fromEnv;
  const fromCfg = fileConfig[configKey];
  if (fromCfg != null && fromCfg !== "") return String(fromCfg);
  return fallback;
}
const BACKEND = pick("BACKEND", "backend", "native").toLowerCase();
const ALLOWED_ORIGIN = pick("ALLOWED_ORIGIN", "allowedOrigin", "");
const VERBOSE = pick("VERBOSE", "verbose", "") === "1";
let AUTOPAIR_URL = pick("AUTOPAIR_URL", "autopairUrl", ALLOWED_ORIGIN || "");
let AUTOPAIR_USER = pick("AUTOPAIR_USER", "autopairUser", os.userInfo().username || "");
let AUTOPAIR_PASSWORD = pick("AUTOPAIR_PASSWORD", "autopairPassword", "");
let AUTOPAIR_AGENT_ID = pick("AUTOPAIR_AGENT_ID", "autopairAgentId", "");
let HOST_PAGE_URL = pick("HOST_PAGE_URL", "hostPageUrl", "");
function normalizeUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}
AUTOPAIR_USER = normalizeUsername(AUTOPAIR_USER);
async function firstRunWizard() {
  const haveConfig = fs.existsSync(CONFIG_PATH) || fs.existsSync(SCRIPT_CONFIG_PATH);
  if (haveConfig || AUTOPAIR_URL || !process.stdin.isTTY) return;
  console.log("");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(" VE Admin agent — first run                                   ");
  console.log(" Answer two quick questions to enable Auto Session, or press  ");
  console.log(" Ctrl+C to skip and run code-only mode.                       ");
  console.log("──────────────────────────────────────────────────────────────");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const ask = (q, def = "") => new Promise(res => {
    rl.question(def ? `${q} [${def}] ` : `${q} `, a => res(String(a).trim() || def));
  });
  const url = await ask("Signaling server URL:", "https://remote-control-cdqo.onrender.com");
  const user = await ask("Username to register as:", os.userInfo().username || "");
  rl.close();
  if (!url || !user) {
    console.log("[config] skipped — auto-pair stays disabled.");
    return;
  }
  AUTOPAIR_URL = url;
  AUTOPAIR_USER = normalizeUsername(user);
  try {
    fs.mkdirSync(CONFIG_DIR, {
      recursive: true
    });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      autopairUrl: url,
      autopairUser: AUTOPAIR_USER,
      allowedOrigin: url
    }, null, 2) + "\n", "utf8");
    console.log(`[config] saved to ${CONFIG_PATH}`);
  } catch (err) {
    console.warn(`[config] couldn't save config.json: ${err.message}`);
  }
}
await firstRunWizard();
if (!AUTOPAIR_AGENT_ID) {
  if (fileConfig.autopairAgentId) {
    AUTOPAIR_AGENT_ID = String(fileConfig.autopairAgentId);
  } else {
    AUTOPAIR_AGENT_ID = `agent-${randomUUID().slice(0, 12)}`;
    try {
      fs.mkdirSync(CONFIG_DIR, {
        recursive: true
      });
      const merged = {
        ...fileConfig,
        autopairAgentId: AUTOPAIR_AGENT_ID
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
    } catch {}
  }
}
const KEY_CODE_TO_VK = {
  KeyA: 0x41,
  KeyB: 0x42,
  KeyC: 0x43,
  KeyD: 0x44,
  KeyE: 0x45,
  KeyF: 0x46,
  KeyG: 0x47,
  KeyH: 0x48,
  KeyI: 0x49,
  KeyJ: 0x4A,
  KeyK: 0x4B,
  KeyL: 0x4C,
  KeyM: 0x4D,
  KeyN: 0x4E,
  KeyO: 0x4F,
  KeyP: 0x50,
  KeyQ: 0x51,
  KeyR: 0x52,
  KeyS: 0x53,
  KeyT: 0x54,
  KeyU: 0x55,
  KeyV: 0x56,
  KeyW: 0x57,
  KeyX: 0x58,
  KeyY: 0x59,
  KeyZ: 0x5A,
  Digit0: 0x30,
  Digit1: 0x31,
  Digit2: 0x32,
  Digit3: 0x33,
  Digit4: 0x34,
  Digit5: 0x35,
  Digit6: 0x36,
  Digit7: 0x37,
  Digit8: 0x38,
  Digit9: 0x39,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7A,
  F12: 0x7B,
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0D,
  Escape: 0x1B,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2D,
  Delete: 0x2E,
  ShiftLeft: 0xA0,
  ShiftRight: 0xA1,
  ControlLeft: 0xA2,
  ControlRight: 0xA3,
  AltLeft: 0xA4,
  AltRight: 0xA5,
  MetaLeft: 0x5B,
  MetaRight: 0x5C,
  CapsLock: 0x14,
  NumLock: 0x90,
  ScrollLock: 0x91,
  ContextMenu: 0x5D,
  Numpad0: 0x60,
  Numpad1: 0x61,
  Numpad2: 0x62,
  Numpad3: 0x63,
  Numpad4: 0x64,
  Numpad5: 0x65,
  Numpad6: 0x66,
  Numpad7: 0x67,
  Numpad8: 0x68,
  Numpad9: 0x69,
  NumpadMultiply: 0x6A,
  NumpadAdd: 0x6B,
  NumpadSubtract: 0x6D,
  NumpadDecimal: 0x6E,
  NumpadDivide: 0x6F,
  NumpadEnter: 0x0D,
  Semicolon: 0xBA,
  Equal: 0xBB,
  Comma: 0xBC,
  Minus: 0xBD,
  Period: 0xBE,
  Slash: 0xBF,
  Backquote: 0xC0,
  BracketLeft: 0xDB,
  Backslash: 0xDC,
  BracketRight: 0xDD,
  Quote: 0xDE,
  IntlBackslash: 0xE2
};
const KEY_CODE_TO_XDO = {
  KeyA: "a",
  KeyB: "b",
  KeyC: "c",
  KeyD: "d",
  KeyE: "e",
  KeyF: "f",
  KeyG: "g",
  KeyH: "h",
  KeyI: "i",
  KeyJ: "j",
  KeyK: "k",
  KeyL: "l",
  KeyM: "m",
  KeyN: "n",
  KeyO: "o",
  KeyP: "p",
  KeyQ: "q",
  KeyR: "r",
  KeyS: "s",
  KeyT: "t",
  KeyU: "u",
  KeyV: "v",
  KeyW: "w",
  KeyX: "x",
  KeyY: "y",
  KeyZ: "z",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
  Backspace: "BackSpace",
  Tab: "Tab",
  Enter: "Return",
  Escape: "Escape",
  Space: "space",
  PageUp: "Prior",
  PageDown: "Next",
  End: "End",
  Home: "Home",
  ArrowLeft: "Left",
  ArrowUp: "Up",
  ArrowRight: "Right",
  ArrowDown: "Down",
  Insert: "Insert",
  Delete: "Delete",
  ShiftLeft: "Shift_L",
  ShiftRight: "Shift_R",
  ControlLeft: "Control_L",
  ControlRight: "Control_R",
  AltLeft: "Alt_L",
  AltRight: "Alt_R",
  MetaLeft: "Super_L",
  MetaRight: "Super_R",
  CapsLock: "Caps_Lock",
  Semicolon: "semicolon",
  Equal: "equal",
  Comma: "comma",
  Minus: "minus",
  Period: "period",
  Slash: "slash",
  Backquote: "grave",
  BracketLeft: "bracketleft",
  Backslash: "backslash",
  BracketRight: "bracketright",
  Quote: "apostrophe"
};
function _normalizeOriginValue(value) {
  if (!value) return "";
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(value).replace(/\/+$/, "");
  }
}
function isAllowedOrigin(origin) {
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") {
        return true;
      }
    } catch {}
  }
  const allow = new Set();
  for (const v of [ALLOWED_ORIGIN, AUTOPAIR_URL, HOST_PAGE_URL]) {
    const n = _normalizeOriginValue(v);
    if (n) allow.add(n);
  }
  if (!origin) return allow.size === 0;
  return allow.has(_normalizeOriginValue(origin));
}
function createNativeBackend() {
  if (process.platform === "win32") return createWindowsBackend();
  if (process.platform === "linux") return createLinuxBackend();
  if (process.platform === "darwin") return createMacBackend();
  console.warn(`[agent] native backend unsupported on ${process.platform}`);
  return null;
}
function createWindowsBackend() {
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
  a[0].type = 1; a[0].u.ki.wScan = (ushort)c; a[0].u.ki.dwFlags = 4;
  a[1].type = 1; a[1].u.ki.wScan = (ushort)c; a[1].u.ki.dwFlags = 4 | 2;
  SendInput(2u, a, System.Runtime.InteropServices.Marshal.SizeOf(typeof(INPUT)));
}
"@
function global:DoMove($nx,$ny) {
  $sw=[W.U]::GetSystemMetrics(0); $sh=[W.U]::GetSystemMetrics(1)
  [W.U]::SetCursorPos([int]($sw*$nx),[int]($sh*$ny)) | Out-Null
}
function global:DoBtn($flag) { [W.U]::mouse_event($flag,0,0,0,0) }
function global:DoScroll($d) { [W.U]::mouse_event(2048,0,0,$d,0) }
function global:DoKeyDown($vk) { [W.U]::keybd_event([byte]$vk, 0, 0, 0) }
function global:DoKeyUp($vk)   { [W.U]::keybd_event([byte]$vk, 0, 2, 0) }
function global:DoType($s) { foreach ($ch in $s.ToCharArray()) { [W.U]::TypeChar($ch) } }
try {
  Add-Type -Name P -Namespace W -MemberDefinition @"
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
"@
  $p = New-Object -TypeName "W.P+POINT"
  [void][W.P]::GetCursorPos([ref]$p)
  [W.U]::SetCursorPos($p.X + 2, $p.Y) | Out-Null
  Start-Sleep -Milliseconds 50
  [W.U]::SetCursorPos($p.X, $p.Y) | Out-Null
  Write-Host "[ps] self-test passed"
} catch {
  Write-Host "[ps] self-test FAILED: $_"
}
Write-Host "[ps] ready"
`;
  const PS_ARGS = ["-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"];
  const PS_CANDIDATES = [`${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "powershell.exe", "pwsh.exe"];
  const trySpawn = exe => {
    try {
      const child = spawn(exe, PS_ARGS, {
        stdio: ["pipe", "pipe", "pipe"]
      });
      return child;
    } catch {
      return null;
    }
  };
  let psIdx = 0;
  let psExe = PS_CANDIDATES[psIdx];
  let ps = trySpawn(psExe);
  const handleSpawnError = err => {
    if (err?.code === "ENOENT" || err?.code === "EACCES") {
      psIdx += 1;
      if (psIdx >= PS_CANDIDATES.length) {
        console.error("[agent] Tried all PowerShell candidates and none worked:", PS_CANDIDATES.join(", "), "\nInstall PowerShell 7+ from https://aka.ms/powershell, " + "or re-enable the stock Windows PowerShell, or the agent can't drive the mouse.");
        return;
      }
      psExe = PS_CANDIDATES[psIdx];
      console.warn(`[agent] PowerShell candidate #${psIdx} failed (${err.code}); trying ${psExe}`);
      const next = trySpawn(psExe);
      if (!next) {
        handleSpawnError({
          code: "ENOENT",
          message: "sync fail"
        });
        return;
      }
      ps = next;
      attachPsHandlers();
      ps.stdin.write(init + "\n");
    } else {
      console.error(`[agent] PowerShell spawn error: ${err.message}`);
    }
  };
  let ready = false;
  const queue = [];
  const writePs = s => {
    if (ready) {
      try {
        ps.stdin.write(s);
      } catch {}
    } else {
      queue.push(s);
    }
  };
  let stdoutBuf = "";
  const attachPsHandlers = () => {
    stdoutBuf = "";
    ps.on("error", handleSpawnError);
    ps.stdout.on("data", d => {
      const chunk = String(d);
      if (VERBOSE) process.stdout.write(`[ps-out] ${chunk}`);
      stdoutBuf += chunk;
      if (!ready && stdoutBuf.includes("[ps] ready")) {
        ready = true;
        console.log(`[agent] PowerShell backend ready (${psExe})`);
        while (queue.length) {
          try {
            ps.stdin.write(queue.shift());
          } catch {}
        }
      }
    });
    ps.stderr.on("data", d => console.warn(`[ps-err] ${String(d).trim()}`));
    ps.on("exit", code => {
      ready = false;
      console.warn(`[agent] ${psExe} exited (code=${code}) — respawning in 1s`);
      setTimeout(() => {
        const next = trySpawn(psExe);
        if (!next) {
          handleSpawnError({
            code: "ENOENT",
            message: "respawn failed"
          });
          return;
        }
        ps = next;
        attachPsHandlers();
        ps.stdin.write(init + "\n");
      }, 1000);
    });
  };
  if (ps) {
    attachPsHandlers();
    ps.stdin.write(init + "\n");
  } else {
    handleSpawnError({
      code: "ENOENT",
      message: "spawn failed synchronously"
    });
  }
  setTimeout(() => {
    if (!ready) {
      console.warn(`[agent] ${psExe} still not ready after 10s. ` + `Possible causes: ExecutionPolicy locked, antivirus blocking ` + `user32.dll access, or the PS host crashed during Add-Type. ` + `Re-run with VERBOSE=1 to see raw PowerShell output.`);
    }
  }, 10_000);
  const DOWN = {
    0: 2,
    1: 32,
    2: 8
  };
  const UP = {
    0: 4,
    1: 64,
    2: 16
  };
  return {
    label: "native:windows",
    get ready() {
      return ready;
    },
    send: line => {
      const sp = line.indexOf(" ");
      const verb = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? "" : line.slice(sp + 1);
      const [a, b] = rest.split(" ");
      if (verb === "MOVE") {
        writePs(`DoMove ${a} ${b}\n`);
      } else if (verb === "DOWN") {
        writePs(`DoBtn ${DOWN[+a] ?? 2}\n`);
      } else if (verb === "UP") {
        writePs(`DoBtn ${UP[+a] ?? 4}\n`);
      } else if (verb === "CLICK") {
        writePs(`DoBtn ${DOWN[+a] ?? 2}\nDoBtn ${UP[+a] ?? 4}\n`);
      } else if (verb === "SCROLL") {
        writePs(`DoScroll ${-Math.round(Number(a) || 0)}\n`);
      } else if (verb === "KEYDOWN") {
        writePs(`DoKeyDown ${+a}\n`);
      } else if (verb === "KEYUP") {
        writePs(`DoKeyUp ${+a}\n`);
      } else if (verb === "TYPE") {
        const esc = rest.replace(/`/g, "``").replace(/'/g, "''");
        writePs(`DoType '${esc}'\n`);
      }
    },
    close: () => {
      try {
        ps.kill();
      } catch {}
    }
  };
}
function createLinuxBackend() {
  let screen = {
    w: 1920,
    h: 1080
  };
  try {
    const r = spawn("xdotool", ["getdisplaygeometry"]);
    r.stdout.on("data", d => {
      const [w, h] = String(d).trim().split(" ").map(n => parseInt(n, 10));
      if (w && h) screen = {
        w,
        h
      };
    });
  } catch (e) {
    console.warn("[agent] couldn't query screen size; assuming 1920x1080");
  }
  const run = args => {
    try {
      spawn("xdotool", args);
    } catch {}
  };
  const BTN = {
    0: "1",
    1: "2",
    2: "3"
  };
  return {
    label: "native:linux",
    send: line => {
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
        run(["click", d < 0 ? "4" : "5"]);
      } else if (verb === "KEYDOWN") {
        if (a) run(["keydown", a]);
      } else if (verb === "KEYUP") {
        if (a) run(["keyup", a]);
      } else if (verb === "TYPE") {
        if (rest) run(["type", "--", rest]);
      }
    },
    close: () => {}
  };
}
function createMacBackend() {
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
  const jx = spawn("osascript", ["-l", "JavaScript", "-e", helper], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  jx.stderr.on("data", d => console.warn(`[osa-err] ${String(d).trim()}`));
  jx.on("exit", code => console.warn(`[agent] osascript exited (code=${code})`));
  return {
    label: "native:macos",
    send: line => {
      try {
        jx.stdin.write(line + "\n");
      } catch {}
    },
    close: () => {
      try {
        jx.kill();
      } catch {}
    }
  };
}
function createVB6Backend() {
  let tcp = null;
  let ready = false;
  let reconnectTimer = null;
  const connect = () => {
    tcp = net.createConnection({
      host: VB6_HOST,
      port: VB6_PORT
    }, () => {
      ready = true;
      console.log(`[agent] connected to VB6 at ${VB6_HOST}:${VB6_PORT}`);
    });
    tcp.setNoDelay(true);
    tcp.on("data", buf => VERBOSE && console.log(`[vb6] ${buf}`));
    const onClosed = () => {
      ready = false;
      tcp = null;
      if (!reconnectTimer) reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, VB6_RECONNECT_DELAY_MS);
    };
    tcp.on("close", onClosed);
    tcp.on("error", err => {
      if (err.code !== "ECONNREFUSED") console.warn(`[agent] VB6 error: ${err.message}`);
      try {
        tcp?.destroy();
      } catch {}
      onClosed();
    });
  };
  connect();
  return {
    label: "vb6",
    get ready() {
      return ready;
    },
    send: line => {
      try {
        if (ready) tcp.write(line + "\n");
      } catch {}
    },
    close: () => {
      try {
        tcp?.destroy();
      } catch {}
    }
  };
}
const backend = BACKEND === "vb6" ? createVB6Backend() : createNativeBackend();
if (!backend) {
  console.error("[agent] no injection backend available on this platform; exiting.");
  process.exit(1);
}
console.log(`[agent] backend: ${backend.label}`);
const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));
const KEY_MAP = process.platform === "linux" ? KEY_CODE_TO_XDO : KEY_CODE_TO_VK;
let lastMoveX = -1;
let lastMoveY = -1;
function translate(ev) {
  if (!ev || typeof ev !== "object") return [];
  if (ev.t === "mouse") {
    const x = clamp01(ev.x),
      y = clamp01(ev.y);
    const btn = Number.isInteger(ev.button) ? ev.button : 0;
    const out = [];
    if (x !== lastMoveX || y !== lastMoveY) {
      out.push(`MOVE ${x.toFixed(4)} ${y.toFixed(4)}`);
      lastMoveX = x;
      lastMoveY = y;
    }
    if (ev.kind === "down") out.push(`DOWN ${btn}`);
    if (ev.kind === "up") out.push(`UP ${btn}`);
    return out;
  }
  if (ev.t === "wheel") {
    const delta = Math.round(Number(ev.dy) || 0);
    if (delta === 0) return [];
    return [`SCROLL ${delta}`];
  }
  if (ev.t === "key") {
    const token = KEY_MAP[ev.code];
    if (token !== undefined) {
      if (ev.kind === "down") return [`KEYDOWN ${token}`];
      if (ev.kind === "up") return [`KEYUP ${token}`];
      return [];
    }
    if (ev.kind === "down" && typeof ev.key === "string" && ev.key.length >= 1 && ev.key.length <= 8 && ev.key !== "Dead") {
      if (ev.key.length === 1 || /^[\p{Emoji}\p{L}]+$/u.test(ev.key)) {
        return [`TYPE ${ev.key}`];
      }
    }
    return [];
  }
  return [];
}
function autopairWsUrl(base) {
  if (!base) return "";
  try {
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/agent";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch (e) {
    console.warn(`[autopair] invalid AUTOPAIR_URL: ${base}`);
    return "";
  }
}
function hostPageUrl(token) {
  if (HOST_PAGE_URL) {
    const hashIdx = HOST_PAGE_URL.indexOf("#");
    if (hashIdx >= 0) {
      const before = HOST_PAGE_URL.slice(0, hashIdx);
      const hash = HOST_PAGE_URL.slice(hashIdx);
      const sep = hash.includes("?") ? "&" : "?";
      return `${before}${hash}${sep}token=${encodeURIComponent(token)}`;
    }
    const sep = HOST_PAGE_URL.includes("?") ? "&" : "?";
    return `${HOST_PAGE_URL}${sep}token=${encodeURIComponent(token)}`;
  }
  if (!AUTOPAIR_URL) return "";
  return `${AUTOPAIR_URL.replace(/\/$/, "")}/#/host?token=${encodeURIComponent(token)}`;
}
function openInBrowser(url) {
  if (!url) return;
  console.log(`[autopair] opening browser at ${url}`);
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], {
        detached: true,
        stdio: "ignore"
      }).unref();
    } else {
      spawn("xdg-open", [url], {
        detached: true,
        stdio: "ignore"
      }).unref();
    }
  } catch (err) {
    console.warn(`[autopair] couldn't open browser (${err.message}). Open manually: ${url}`);
  }
}
let autopairWs = null;
let autopairBackoffMs = 1000;
let autopairTimer = null;
let autopairWanted = Boolean(AUTOPAIR_URL && AUTOPAIR_USER);
function connectAutopair() {
  if (!autopairWanted) return;
  const url = autopairWsUrl(AUTOPAIR_URL);
  if (!url) return;
  const pwdHint = AUTOPAIR_PASSWORD ? `(${AUTOPAIR_PASSWORD.length} chars)` : "(none)";
  console.log(`[autopair] connecting to ${url} as user="${AUTOPAIR_USER}" pwd=${pwdHint} agentId=${AUTOPAIR_AGENT_ID}`);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.warn(`[autopair] construct failed: ${err.message}`);
    scheduleAutopairReconnect();
    return;
  }
  autopairWs = ws;
  let heartbeat = null;
  ws.on("open", () => {
    autopairBackoffMs = 1000;
    try {
      ws.send(JSON.stringify({
        type: "agent:hello",
        user: AUTOPAIR_USER,
        password: AUTOPAIR_PASSWORD,
        agentId: AUTOPAIR_AGENT_ID
      }));
    } catch {}
    heartbeat = setInterval(() => {
      try {
        ws.send(JSON.stringify({
          type: "agent:ping"
        }));
      } catch {}
    }, AGENT_HEARTBEAT_INTERVAL_MS);
  });
  ws.on("message", buf => {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "agent:registered") {
      console.log(`[autopair] registered (user="${msg.user}")`);
      return;
    }
    if (msg.type === "agent:pong") return;
    if (msg.type === "open-session") {
      const token = String(msg.token || "");
      const mgr = String(msg.managerName || "?");
      if (!token) return;
      console.log(`[autopair] open-session from manager "${mgr}" token=${token.slice(0, 8)}…`);
      openInBrowser(hostPageUrl(token));
      return;
    }
    if (VERBOSE) console.log("[autopair] unknown msg", msg);
  });
  const onClosed = (code, reason) => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (autopairWs === ws) autopairWs = null;
    if (!autopairWanted) return;
    console.warn(`[autopair] disconnected (code=${code} reason=${String(reason || "")}). Reconnecting in ${autopairBackoffMs}ms`);
    scheduleAutopairReconnect();
  };
  ws.on("close", (code, reason) => onClosed(code, reason));
  ws.on("error", err => {
    if (VERBOSE) console.warn(`[autopair] ws error: ${err.message}`);
  });
}
function scheduleAutopairReconnect() {
  if (autopairTimer) return;
  autopairTimer = setTimeout(() => {
    autopairTimer = null;
    autopairBackoffMs = Math.min(autopairBackoffMs * 2, 30_000);
    connectAutopair();
  }, autopairBackoffMs);
}
if (autopairWanted) {
  connectAutopair();
} else if (AUTOPAIR_URL) {
  console.warn(`[autopair] AUTOPAIR_URL set but AUTOPAIR_USER is empty; auto-pair disabled.`);
} else {
  console.log("[autopair] disabled (set AUTOPAIR_URL to enable manager-initiated sessions).");
}
let wss;
let _portRetryTimer = null;
let _portRetryAttempts = 0;
const PORT_MAX_ATTEMPTS = 60;
function buildWss() {
  return new WebSocketServer({
    host: WS_HOST,
    port: WS_PORT,
    verifyClient: ({
      origin,
      req
    }, done) => {
      if (!isAllowedOrigin(origin)) {
        console.warn(`[agent] rejecting connection: Origin=${origin || "(none)"} not allowed`);
        return done(false, 403, "Origin not allowed");
      }
      const ip = req.socket.remoteAddress;
      if (!LOOPBACK_ADDRS.has(ip)) {
        console.warn(`[agent] rejecting non-loopback caller ${ip}`);
        return done(false, 403, "Loopback only");
      }
      done(true);
    }
  });
}
function startWss() {
  wss = buildWss();
  wireWss(wss);
}
function wireWss(server) {
  server.on("error", err => {
    if (err && err.code === "EADDRINUSE") {
      _portRetryAttempts += 1;
      if (_portRetryAttempts === 1 || _portRetryAttempts % 4 === 0) {
        console.warn(`[agent] port ${WS_PORT} busy (EADDRINUSE), retrying ` + `(attempt ${_portRetryAttempts}/${PORT_MAX_ATTEMPTS})…`);
      }
      if (_portRetryAttempts >= PORT_MAX_ATTEMPTS) {
        console.error(`[agent] port ${WS_PORT} still busy after ` + `${PORT_MAX_ATTEMPTS * 0.5}s — exiting so the scheduled ` + `task can respawn us in a fresh process.`);
        process.exit(1);
      }
      try {
        server.close();
      } catch {}
      if (_portRetryTimer) clearTimeout(_portRetryTimer);
      _portRetryTimer = setTimeout(() => {
        _portRetryTimer = null;
        try {
          startWss();
        } catch (e) {
          console.error(`[agent] retry startWss threw: ${e?.message || e}`);
          process.exit(1);
        }
      }, 500);
      return;
    }
    console.error(`[agent] WebSocketServer error: ${err?.message || err}`);
  });
  server.on("connection", onWssConnection);
  server.on("listening", () => {
    if (_portRetryAttempts > 0) {
      console.log(`[agent] port ${WS_PORT} acquired after ${_portRetryAttempts} retries.`);
      _portRetryAttempts = 0;
    }
    console.log(`[agent] WebSocket ready at ws://${WS_HOST}:${WS_PORT}`);
    console.log(`[agent] Origin allowlist: ${ALLOWED_ORIGIN || "(loopback pages only)"}`);
  });
}
function onWssConnection(ws, req) {
  console.log(`[agent] browser connected (origin=${req.headers.origin || "-"})`);
  const reportStatus = () => {
    const msg = {
      type: "agent:status",
      backend: backend.label,
      ready: backend.ready ?? true
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  };
  reportStatus();
  const statusTimer = setInterval(reportStatus, 2000);
  ws.on("message", raw => {
    let ev;
    try {
      ev = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    for (const line of translate(ev)) backend.send(line);
  });
  ws.on("close", () => {
    clearInterval(statusTimer);
    console.log("[agent] browser disconnected");
  });
}
startWss();
process.on("SIGINT", () => {
  console.log("\n[agent] shutting down");
  autopairWanted = false;
  if (autopairTimer) {
    clearTimeout(autopairTimer);
    autopairTimer = null;
  }
  try {
    autopairWs?.close();
  } catch {}
  try {
    backend.close();
  } catch {}
  try {
    wss?.close();
  } catch {}
  process.exit(0);
});
