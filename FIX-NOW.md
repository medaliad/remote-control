# FIX NOW — 404 on /api/sessions/open + agent on dali PC

This explains exactly what was wrong, what was fixed, and what you still
have to do on each computer.

## What was wrong

The TypeScript source in `server/src/index.ts` already defines three
routes:

- `POST /api/sessions/open` — mints a pairing token, pushes "open-session"
  to the target user's agent
- `POST /api/users/login` — VE Admin login presence ping
- `POST /api/agent/lookup` — debug "is this user's agent online?"

But `server/dist/index.js` was last compiled before those routes existed.
Render runs `node server/dist/index.js`, so it's been serving the old
binary — that's the 404.

## What was fixed in this commit

1. Rebuilt `server/dist/` from the current source (the route is now in
   the JS that Render runs).
2. Normalized the agent username everywhere to `trim().toLowerCase()` so
   `Dali` / ` dali ` / `DALI` all map to the same key the server uses.
   Edits are in `agent/agent.js` and `agent/install.ps1`.

## What you have to do

### 1. Redeploy the server on Render

Two ways to make Render pick up the new build:

**Easiest — push and let auto-deploy run:**
```
git add server/dist agent/agent.js agent/install.ps1 FIX-NOW.md
git commit -m "Fix /api/sessions/open 404 + normalize agent username"
git push origin main
```

**Or manually redeploy from the Render dashboard:**
Render → `remote-access` service → **Manual Deploy** → **Deploy latest
commit**.

After deploy, sanity-check from anywhere:
```
curl -i https://remote-control-cdqo.onrender.com/health
curl -i -X POST https://remote-control-cdqo.onrender.com/api/sessions/open \
     -H "Content-Type: application/json" \
     -d '{"targetUser":"dali"}'
```
You should now see `200 ok agent-offline` (not 404). 200 with
`agent-offline` is *correct* when dali's agent isn't running yet — it
proves the route exists.

### 2. Install the agent on the dali PC

On the dali computer (logged in as Windows user `dali`):

```powershell
cd "C:\path\to\agent"   # the folder containing install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
    -ServerUrl "https://remote-control-cdqo.onrender.com" `
    -Username  "dali"
```

The installer:
- copies the agent to `%LocalAppData%\VEAdminAgent\`
- writes `config.json` with `autopairUser: "dali"` (normalized)
- registers a Scheduled Task that **auto-launches the agent every time
  dali logs into Windows, hidden, and respawns it on crash**
- starts it now so you don't have to log out

### 3. Verify the agent is registered

On the dali PC:
```powershell
Get-Content -Wait "$env:LOCALAPPDATA\VEAdminAgent\agent.log"
```
Look for:
```
[autopair] connecting to wss://remote-control-cdqo.onrender.com/agent as user="dali" agentId=agent-…
[autopair] registered (user="dali")
```

From any other computer:
```
curl -X POST https://remote-control-cdqo.onrender.com/api/agent/lookup \
     -H "Content-Type: application/json" \
     -d '{"user":"dali"}'
# {"ok":true,"user":"dali","live":true,"agent":{...}}
```

`"live":true` is the green light.

### 4. From the admin PC, open a session for dali

Log into VE Admin as the manager (Mohamed). Click **Open Session →
dali**. The Flutter app calls `RemoteSessionService.openAutoSession`,
which POSTs `/api/sessions/open` with `targetUser: "dali"`. The server
pushes `open-session` over the agent WebSocket; the agent on the dali
PC opens its default browser at the host page. The manager UI loads the
client iframe pointed at the same token — paired automatically, no
codes.

## How "auto-open session on login" actually works

This is already built in:

- VE Admin Flutter app, on successful login (`auth_notifier.dart:48-53`),
  calls `_remote.registerOnLogin(username)` which POSTs `/api/users/login`
  to record presence.
- The agent, started by the Scheduled Task at Windows logon, opens a
  persistent WebSocket to `/agent` and sends `agent:hello` with the
  configured username.
- When a manager clicks "Open Session", the server pairs them in one
  round-trip.

Nothing else to wire — the chain is already complete once the server is
redeployed and the agent is installed on the dali PC.

## If `/api/agent/lookup` still says `live:false` after install

1. The Scheduled Task isn't running:
   `Get-ScheduledTask -TaskName VEAdminAgent | Get-ScheduledTaskInfo`
   `Start-ScheduledTask -TaskName VEAdminAgent`
2. Outbound WSS is blocked. Open
   `https://remote-control-cdqo.onrender.com/health` in dali's browser —
   if it doesn't load, it's a network issue, not the agent.
3. The username in `%LocalAppData%\VEAdminAgent\config.json` doesn't
   match the manager's call. Open it in Notepad, fix `autopairUser`,
   then `Stop-ScheduledTask` + `Start-ScheduledTask`.
