# Remote Access

Browser-to-browser screen sharing with explicit per-connection approval. The host chooses which screen to share, the client requests access, and the host approves before anything streams.

```
┌──────────────┐     short code     ┌──────────────┐
│   HOST       │ ────────────────▶  │   CLIENT     │
│ (browser)    │ ◀── join request ─ │ (browser)    │
│   approve? ──┼────── yes/no ────▶ │              │
│   screen ────┼──── WebRTC P2P ──▶ │  <video>     │
└──────────────┘                    └──────────────┘
        │       ws (signaling only)      │
        └───────────────┬────────────────┘
                ┌───────▼───────┐
                │  Node server  │
                └───────────────┘
```

The server only relays the WebRTC handshake. Screen data travels peer-to-peer and never transits the server.

## Repository layout

```
server/     Node.js signaling server + static host (TypeScript)
web/        React + Vite frontend (TypeScript)
agent/      Local mouse/keyboard bridge — runs on the host's machine
vb6-agent/  Optional legacy VB6 mouse injector (Windows)
```

## Development

Requires Node 20+.

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. Vite proxies `/ws` to the signaling server on `:3000`.

## Production build

```bash
npm run build
npm start
```

Serves everything on `http://localhost:3000`.

## Agent (remote mouse/keyboard)

The agent runs on the host's machine and translates WebRTC input events into real OS mouse/keyboard actions. It binds to `127.0.0.1:8766` — nothing remote can reach it.

### Install on Windows (one-liner)

```powershell
iex (iwr "https://your-server.onrender.com/install/bootstrap.ps1?user=<username>").Content
```

### Install manually

```powershell
powershell -ExecutionPolicy Bypass -File .\agent\install.ps1
```

See [agent/INSTALL.md](agent/INSTALL.md) for full install, update, and uninstall instructions.

### Run manually (no installer)

```bash
cd agent
npm install
npm start
```

Backend is selected automatically:

| Platform | Backend |
| --- | --- |
| Windows | PowerShell + `user32.dll` (`SetCursorPos`, `mouse_event`) |
| macOS | `osascript` with CoreGraphics `CGEvent` |
| Linux | `xdotool` |

Lock the agent to your server's origin so only pages from there can drive the mouse:

```bash
# macOS / Linux
ALLOWED_ORIGIN=https://your-server.onrender.com npm start

# Windows (PowerShell)
$env:ALLOWED_ORIGIN = "https://your-server.onrender.com"; npm start
```

## Deploy to Render

1. Push this repo to GitHub or GitLab.
2. In Render: **New → Blueprint**, point it at the repo. Render reads `render.yaml` and creates a single Web Service.
3. Use the **Starter** plan — the Free plan sleeps on idle and drops WebSockets.

## Environment variables

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `SESSION_TTL_MS` | `1800000` | Max session lifetime (ms) |
| `AUTOPAIR_TOKEN` | (empty) | API key for `POST /api/sessions/open` — if unset, the endpoint is open |
| `AUTOPAIR_ALLOWED_ORIGINS` | `*` | CORS origins for `/api/*` |

### Agent

| Variable | Default | Description |
| --- | --- | --- |
| `BACKEND` | `native` | `native` or `vb6` |
| `ALLOWED_ORIGIN` | (empty) | Restrict agent WebSocket to this origin |
| `AUTOPAIR_URL` | (empty) | Signaling server URL — enables manager-initiated sessions |
| `AUTOPAIR_USER` | (empty) | Username the agent registers as |
| `VERBOSE` | (unset) | Set to `1` to log every backend command |

## Security

- Session codes are single-use — once a client connects the code is retired
- Host must explicitly approve every connection request
- Agent binds to `127.0.0.1` only — no remote access possible
- Remote input is off by default; host enables it per session
- Screen stream is peer-to-peer; the server only sees signaling metadata

## License

MIT
