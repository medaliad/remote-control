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

## Remote mouse control (VB6 pipeline)

By itself, the browser sandbox can't move your OS cursor. To actually drive
the host's mouse, we add two local processes — inspired by the React ↔ Node
↔ VB6 approach in [this write-up][vb6-article]:

```
 client browser           host browser            local agent          VB6
 ───────────────   WebRTC ──────────────  WebSocket ───────────  TCP  ───────
 mouse events ──▶  Host.tsx         ──▶  agent/agent.js    ──▶  MouseControl
                   (receives over              (127.0.0.1:8766)      (127.0.0.1:8765)
                    data channel)                                    │
                                                                     ▼
                                                          user32.dll: SetCursorPos,
                                                                      mouse_event
```

[vb6-article]: https://medium.com/@sahasourav630/building-a-real-time-mouse-control-system-with-react-node-js-and-vb6-9ea67f36096f

### On the host machine, one-time setup

1. **Compile the VB6 program.** Open `vb6-agent/MouseControl.vbp` in Visual
   Basic 6 (requires `MSWINSCK.OCX`, which ships with VB6). Hit
   *File → Make MouseControl.exe*. Launch the resulting `.exe` — it binds
   to `127.0.0.1:8765` and shows a tiny log window.
2. **Install and start the agent:**
   ```bash
   cd agent
   npm install
   npm start
   ```
   The agent logs `[agent] connected to VB6 at 127.0.0.1:8765` when the two
   are talking. It auto-reconnects if you restart either side.

### On the host's browser

Open the Host page as usual, approve the client, then toggle **Allow remote
input**. The sidebar shows a live status card:

- *Connected.* — agent + VB6 both reachable, cursor is being driven.
- *Agent running, VB6 not attached.* — start `MouseControl.exe`.
- *Can't reach the local agent.* — run `npm start` in `agent/`.

### Wire protocol (agent → VB6)

Newline-delimited ASCII over TCP. All coordinates are normalized 0..1.

```
MOVE 0.4125 0.8832
DOWN 0                # 0=left, 1=middle, 2=right
UP 0
CLICK 2               # right-click at current cursor pos
SCROLL -120           # positive = scroll up (Windows convention)
PING
```

The VB6 side replies `OK\n`, `PONG\n`, or `ERR <reason>\n` per command.

### Safety

Both the VB6 listener and the Node agent bind to `127.0.0.1` only — nothing
off-box can drive your mouse. The browser host only forwards input when
**Allow remote input** is on, and the `host:setControl` signal is echoed to
the client so they can see it flip on/off in real time.

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
