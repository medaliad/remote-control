# Remote Access

Browser-to-browser screen sharing with **explicit per-connection approval**.
No auto-accept, no background streaming, no OS-level hooks — the host picks
which screen/window to share, and the client sees exactly that.

```
┌──────────────┐        short code        ┌──────────────┐
│   HOST       │ ─────────────────────▶   │   CLIENT     │
│ (browser)    │                          │ (browser)    │
│              │ ◀── "Can I connect?" ─── │              │
│   approve? ──┼──────── yes/no ────────▶ │              │
│              │                          │              │
│   screen ────┼────── WebRTC P2P ──────▶ │  <video>     │
└──────────────┘                          └──────────────┘
        │  ws (JSON signaling only)  │
        └────────────┬───────────────┘
              ┌──────▼──────┐
              │ Node server │
              │ (relays     │
              │  handshake) │
              └─────────────┘
```

The Node server only relays the approval handshake and WebRTC SDP/ICE
packets. The screen itself travels peer-to-peer via WebRTC — it never
transits the server.

## Features

- Short one-time session codes (confusable-free alphabet, e.g. `K7TQ9P`)
- Host approves every single connection request; no "remember this client"
- Optional remote-input toggle that drives a **real Windows cursor** via a
  small VB6 program using `SetCursorPos` / `mouse_event` (Win32 API)
- Single-origin deploy (same host serves the app and the WebSocket) so
  HTTPS/WSS just works without CORS or Mixed Content gotchas
- Graceful disconnect handling — closing the tab, hitting "End session",
  or losing the network all produce the same clear state on the other side

## Repository layout

```
server/        Node + ws signaling / static host (TypeScript)
  src/
    index.ts            HTTP + WS glue, SPA fallback, /health
    session-manager.ts  Session lifecycle, approval gating
    code.ts             Short code generator
    types.ts            Wire protocol
web/           Vite + React + TypeScript front-end
  src/
    pages/Home.tsx      Landing page, two choices
    pages/Host.tsx      Host state machine  (talks to local agent)
    pages/Client.tsx    Client state machine
    lib/signaling.ts    Typed WebSocket wrapper
    lib/webrtc.ts       Peer w/ perfect negotiation
agent/         Node.js local bridge (browser <-> VB6)
  agent.js            WebSocket server on 127.0.0.1:8766,
                      TCP client to VB6 on 127.0.0.1:8765
vb6-agent/     VB6 program that injects mouse events into Windows
  MouseControl.vbp    VB6 project file
  MouseControl.frm    Winsock listener + command parser
  MouseControl.bas    Win32 API wrappers (SetCursorPos, mouse_event)
render.yaml    One-service Render Blueprint
```

## Remote mouse control

The browser sandbox can't move your OS cursor, so we add one small local
process — the agent in `agent/` — that runs on whichever machine is doing
the screen-sharing. Nothing about mouse control lives on Render; Render
is just the signaling/static host.

```
 client browser        host browser         local agent              OS mouse
 ───────────────  WebRTC ──────────── ws  ──────────────  spawn   ─────────────
 mouse events ──▶ Host.tsx       ──▶ agent/agent.js  ──▶ PowerShell (Windows)
                                       (127.0.0.1:8766)      xdotool    (Linux)
                                                             osascript  (macOS)
```

Inspiration for the React ↔ Node ↔ VB6 three-tier pattern comes from
[this write-up][vb6-article]; the classic VB6 variant still ships here as
an optional backend.

[vb6-article]: https://medium.com/@sahasourav630/building-a-real-time-mouse-control-system-with-react-node-js-and-vb6-9ea67f36096f

### On the host machine, one-time setup

```bash
cd agent
npm install
npm start
```

The agent picks an injection backend automatically:

- **Windows** — spawns a persistent PowerShell child that calls
  `user32.dll`'s `SetCursorPos` / `mouse_event` (same Win32 APIs the VB6
  program uses). No extra install needed.
- **macOS** — spawns `osascript` running a small JXA helper that posts
  `CGEvent` mouse events. You'll be asked to grant *Accessibility*
  permission to Terminal/node the first time.
- **Linux** — spawns `xdotool` (install via `sudo apt install xdotool` or
  your distro's equivalent).

### Optional: the VB6 backend

If you'd rather use the original VB6 program as the injector:

1. Compile it: open `vb6-agent/MouseControl.vbp` in Visual Basic 6
   (requires `MSWINSCK.OCX`, which ships with VB6). *File → Make
   MouseControl.exe*. Launch the `.exe` — it binds to `127.0.0.1:8765`
   and shows a tiny log window.
2. Start the agent in VB6-forwarding mode:
   ```bash
   BACKEND=vb6 npm start
   ```

The agent then becomes a thin pipe: browser → WebSocket → TCP → VB6 →
Win32. You get the GUI log window and a process you can kill with one
click; the trade-off is an extra hop and the need to compile VB6.

### On the host's browser

Open the Host page (served from Render or localhost), approve the
client, then toggle **Allow remote input**. The sidebar shows live
status.

### Running on Render

Render only runs the signaling server + static web app — the agent
stays on the host's computer. When the Host page served from Render
opens a WebSocket to the local agent, the browser is doing a mixed
`https → ws://127.0.0.1` call, which all major browsers permit because
loopback is treated as a potentially-trustworthy origin.

Before `npm start` on the host, lock the agent to your Render URL so
only pages from there can drive your mouse:

```bash
# Windows (PowerShell)
$env:ALLOWED_ORIGIN = "https://your-service.onrender.com"; npm start
# macOS / Linux
ALLOWED_ORIGIN=https://your-service.onrender.com npm start
```

With `ALLOWED_ORIGIN` set, the agent rejects WebSocket upgrades whose
`Origin` header doesn't match — so even a malicious tab open on the same
machine can't drive the cursor unless it came from your Render app.

### Wire protocol (browser → agent)

JSON events over WebSocket; the agent translates each into a
newline-delimited command for the chosen backend (PowerShell / xdotool /
osascript / VB6-TCP). All coordinates are normalized 0..1.

```
{ "t": "mouse", "kind": "move",  "x": 0.4125, "y": 0.8832 }
{ "t": "mouse", "kind": "down",  "x": 0.5,    "y": 0.5,   "button": 0 }
{ "t": "mouse", "kind": "click", "x": 0.5,    "y": 0.5,   "button": 2 }
{ "t": "wheel", "dy": -120 }
```

### Safety

- The agent binds to `127.0.0.1` only — nothing off-box can reach it.
- `ALLOWED_ORIGIN` locks the WebSocket upgrade to a specific page.
- The browser host only forwards input when **Allow remote input** is
  on; the `host:setControl` signal is echoed to the client so they can
  see it flip on/off in real time.
- The VB6 backend, if used, also binds loopback-only.

### Env vars

| Var | Default | Purpose |
| --- | ------- | ------- |
| `BACKEND` | `native` | `native` = direct OS injection; `vb6` = TCP-forward to `MouseControl.exe` |
| `ALLOWED_ORIGIN` | (empty → loopback pages only) | Browser Origin whitelist for the agent's WebSocket |
| `VERBOSE` | unset | Set to `1` to log each command the backend sends |

## Local development

Requires Node 20+.

```bash
npm install
npm run dev
```

That starts the signaling server on `http://localhost:3000` and Vite on
`http://localhost:5173`. Vite proxies `/ws` to the signaling server, so
you can just open `http://localhost:5173` in two browser windows and test
end-to-end.

WebRTC's `getDisplayMedia()` requires a **secure context**. Localhost counts
as secure, so this works out of the box. Don't test over a LAN IP in
production mode without TLS — the browser will refuse to share the screen.

## Production build (local)

```bash
npm run build
npm start
```

The server serves `web/dist/*` on `/` and WebSocket signaling on `/ws`.
Open `http://localhost:3000` in two browser windows.

## Deploying to Render

1. Push this repo to GitHub / GitLab.
2. In Render: **New → Blueprint** and point it at the repo. Render will
   pick up `render.yaml` and create a single Web Service.
3. Use the **Starter** plan (not Free). Free plans sleep on idle and drop
   WebSockets — the first approval request would time out on a cold boot.
4. Once live, the service will be at `https://<your-service>.onrender.com`.
   Browsers will auto-upgrade the WebSocket to `wss://` because the page
   itself is HTTPS.

Render env vars you might want to tweak:

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | injected by Render | HTTP port to listen on |
| `NODE_ENV` | `production` | Loosens dev-only logging |
| `SESSION_TTL_MS` | `1800000` (30 min) | Max session lifetime |

## Security notes

- Codes are single-use: once a client is paired, the same code cannot
  onboard another client. The session ends if the host closes their tab.
- The server only forwards signaling messages *after* the host has sent an
  explicit `host:approve`. Everything before that is rejected.
- The "remote control" toggle injects real mouse events via the local VB6
  agent described above. It's gated by: (a) the host's explicit approval of
  the session, (b) the host flipping the toggle on, (c) the VB6 program
  being running, and (d) the Node agent being running. Any one of those
  being off means the mouse doesn't move. The browser never talks to VB6
  directly — only through the loopback-bound Node bridge.

## License

MIT
