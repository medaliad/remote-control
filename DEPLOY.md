# Deploying Remote Control in your company

This document is the IT-admin playbook. It assumes you want to roll this out
internally — e.g. so your support team can take over a user's desktop on
demand — and have the install-and-forget feel of Chrome Remote Desktop.

## What a user sees

1. They run a single install command (or an MSI/PKG pushed by MDM — you
   decide). Nothing else to configure.
2. A browser tab opens at `http://localhost:3000/host` showing:
   - the **device name** (persistent, = their machine's hostname unless you override)
   - a fresh **6-digit PIN** (rotates on every agent restart)
   - a **one-tap share link** (paste in Slack/Teams/iMessage — the recipient
     lands in the session with no manual PIN entry)
3. From then on, the agent auto-starts at every login.

## What you (IT) need

- Nothing custom-hosted for LAN-only use — the combined server ships the relay,
  so controllers on the same network connect directly.
- For remote workers, expose `combined-server.mjs` on a server they can reach
  (Render, Fly, on-prem) and set `RELAY_URL` on each host to
  `wss://relay.example.com/relay`. A Tailscale / Cloudflare Tunnel works too.

## Render deployment (step-by-step)

The repo ships a `render.yaml` blueprint that deploys the combined server
(Next.js UI + WebSocket relay + `/devices` API) as a **single web service**.
**Important:** the host agent is *never* deployed to Render — it runs on
whatever local machine you want to control.

1. **Deploy the relay to Render**

   Push the repo to GitHub, then on Render click *New → Blueprint* and point
   at the repo. Render picks up `render.yaml`, builds with

   ```
   npm install --include=dev && npm --workspace apps/web run build
   ```

   and starts with `node combined-server.mjs`. Use the **Starter plan or
   higher** — the Free plan sleeps on idle and drops long-lived WebSockets.

2. **Grab the public URL** Render hands you, e.g.
   `https://remote-control-xyz.onrender.com`. This is both the controller UI
   *and* the relay. Open it in a browser: you should see the device picker
   with "No devices online" (expected — no host has registered yet) and a
   working `/health` endpoint.

3. **Install the host agent on the machine you want to control**, and point
   it at your Render URL:

   ```bash
   # one-time — persists to config.json so restarts pick it up
   npm run host -- --relay wss://remote-control-xyz.onrender.com/relay
   ```

   You can also grab this exact command by opening
   `https://remote-control-xyz.onrender.com/host` — it detects the remote
   origin and prints a copy-paste installer line.

4. **Open `https://remote-control-xyz.onrender.com/` on any device** (phone,
   tablet, other laptop), pick the host, type the PIN shown in the host
   terminal. Done.

### Troubleshooting Render deploys

| Symptom | Likely cause |
|---|---|
| Picker shows "Mixed content: this page is HTTPS but the relay URL is not" | Custom relay URL saved in Settings is `ws://` or `http://`. Reset to default. |
| Picker shows "Cannot reach relay at https://…" | The Render service isn't running / not yet deployed. Check `/health`. |
| `/host` page shows "Relay is online" but host agent never appears in the picker | The host agent isn't running locally, or its `--relay` doesn't match the Render URL. Check the agent's terminal for `connect failed`. |
| Connections drop after ~100s of idle | Using the **Free** plan. Upgrade to Starter — Free reaps idle HTTP upgrades. |
| `503` during deploy | Render is still building; `/health` returns 200 once `combined-server.mjs` is listening. |

## One-line install

### Windows (PowerShell, no admin)

```powershell
iwr -useb https://your.intranet/install.ps1 | iex
```

Behind the scenes this script will:
- verify Node.js ≥ 18,
- `npm ci` + `npm run build:combined`,
- drop a wrapper `.cmd` + a Startup-folder shortcut, so the agent launches at
  every sign-in (per-user, no admin required),
- start the agent and open the dashboard.

### macOS / Linux

```bash
curl -fsSL https://your.intranet/install.sh | bash
```

Same flow, with a launchd plist on macOS and a `systemd --user` unit on Linux.

### Uninstall

- Windows: `powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1`
- macOS / Linux: `./scripts/uninstall.sh`

## Configuration (all optional env vars)

Set these before running the installer, or edit the Startup shortcut /
launchd plist / systemd unit afterwards.

| Var | Purpose | Default |
|---|---|---|
| `PORT` | Port for the combined web + relay server | `3000` |
| `LOCAL_PORT` | Loopback info server on the host machine | `4001` |
| `DEVICE_NAME` | Friendly display name in the picker | OS hostname |
| `RELAY_URL` | Override if pointing to a central relay | `ws://localhost:${PORT}/relay` |
| `NO_BROWSER` | Suppress the auto-open browser tab | unset |

Identity and settings persist in:
- Windows: `%APPDATA%\remote-control\{device,config}.json`
- macOS / Linux: `$XDG_CONFIG_HOME/remote-control/{device,config}.json` (fallback `~/.config/...`)

`config.json` currently holds `{"relayUrl": "..."}`. Precedence the host
agent applies at startup, highest first:

1. `RELAY_URL` env var (one-shot override)
2. `config.json` (persisted — set with `npm run host -- --relay <url>`)
3. `ws://localhost:<PORT>/relay` (default, dev-only)

So the canonical "point this machine at our company relay" command is:

```bash
npm run host -- --relay wss://relay.example.com/relay
```

Run that once; every restart afterwards re-reads the saved URL.

## What actually gets installed

The installer never writes outside the repo dir and the user-level startup
hooks below — no registry, no system services, no admin.

| OS | What | Where |
|---|---|---|
| Windows | wrapper script | `<repo>\scripts\rc-host-launch.cmd` |
| Windows | autostart shortcut | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Remote Control Host.lnk` |
| macOS | launchd agent | `~/Library/LaunchAgents/io.remote-control.host.plist` |
| Linux | systemd user unit | `~/.config/systemd/user/remote-control.service` |

Logs on macOS/Linux go to `<repo>/rc-host.log` and `<repo>/rc-host.err.log`.

## Org rollout

For **Microsoft Intune / Jamf** push:
- Package this repo as a zip.
- Deploy with a post-install script that runs
  `install.ps1 -DeviceName "$env:COMPUTERNAME" -RelayUrl "wss://relay.example.com/relay"`
  (or the bash equivalent).
- Optional: set `DEVICE_NAME` to something like `$USER — $HOST` so the
  support team can search the picker by username.

For **GPO-driven rollout without MDM**: put the repo on a shared drive and
run `install.ps1` via a login script. The script is idempotent, so
re-running it just updates the install.

## Security notes

- The PIN is generated client-side on the host and rotates on every agent
  restart. It's never logged, never hits disk, and the `/devices` endpoint
  deliberately omits it. The share link does include it — treat it like a
  one-time password.
- Input injection requires OS permission: Accessibility on macOS, an X11
  session on Linux (Wayland won't work), nothing special on Windows.
- The public relay only forwards bytes — it never stores frames.
- There is currently **no account auth** on the relay. For internet-facing
  deployments, put the relay behind Tailscale, a Cloudflare Tunnel, or an
  SSH tunnel. Account-scoped device lists are a planned follow-up.
