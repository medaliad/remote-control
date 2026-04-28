# VE Admin Agent — Installer

The agent is the small Node.js process that lives on each user's PC. It
keeps a WebSocket open to the signaling server so a manager can click
**Open Session** in VE Admin and the user's screen comes online without
codes, copy-paste, or PowerShell.

This folder ships two scripts to make that automatic on Windows:

| Script | What it does |
| --- | --- |
| `install.ps1` | Installs the agent under `%LocalAppData%\VEAdminAgent\`, writes `config.json`, registers a Scheduled Task so the agent autostarts at every logon (hidden), and starts it now. |
| `uninstall.ps1` | Removes the Scheduled Task and deletes the install folder. |

No admin rights needed. Everything lives in the user's profile.

## Prerequisites

- Windows 10 / 11
- Node.js 20 or newer — install once from <https://nodejs.org/en/download>
  (the LTS installer is fine). The script will fail-fast with a clear
  message if Node is missing or too old.

## Install (interactive)

From the folder containing this README, open PowerShell and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The script will:

1. Check for Node 20+.
2. Copy the agent files to `%LocalAppData%\VEAdminAgent\` (`C:\Users\<you>\AppData\Local\VEAdminAgent\`).
3. `npm install` the runtime dependency (`ws`).
4. Prompt for two values, with sensible defaults pre-filled:
   - **Signaling server URL** — e.g. `https://remote-control-cdqo.onrender.com`
   - **Username to register as** — defaults to your Windows username; type
     the VE Admin pseudo / display name you want this PC paired with
     (e.g. `Aisha Al Mansoori`).
5. Register a Scheduled Task named `VEAdminAgent` that runs at every user
   logon, hidden, and automatically respawns if the agent crashes.
6. Start the task right away so you don't have to log out.

Done. The agent is now live for this PC and survives reboots.

## Install (silent / scripted)

For mass rollouts (Intune, Group Policy, MDM, etc.) skip the prompts:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
    -ServerUrl "https://remote-control-cdqo.onrender.com" `
    -Username  "Aisha Al Mansoori" `
    -NonInteractive
```

`-NonInteractive` makes the script abort (instead of prompting) if any
required value is missing — exactly what you want in an unattended
deployment.

## Verify it's working

In the same PowerShell window:

```powershell
# 1. The Scheduled Task is registered + ran
Get-ScheduledTask -TaskName VEAdminAgent | Get-ScheduledTaskInfo

# 2. The agent log shows registration with the signaling server
Get-Content -Wait "$env:LOCALAPPDATA\VEAdminAgent\agent.log"
```

You should see lines like:

```
[autopair] connecting to wss://remote-control-cdqo.onrender.com/agent as user="Aisha Al Mansoori" agentId=agent-…
[autopair] registered (user="aisha al mansoori")
[agent] backend: native:windows
[agent] WebSocket ready at ws://127.0.0.1:8766
```

The `[autopair] registered` line is the green light — the server now
knows this PC belongs to that user, and **Open Session** in VE Admin will
just work.

You can also confirm from any other machine:

```bash
curl https://remote-control-cdqo.onrender.com/health
# {"ok":true,…,"agents":1,…}
```

## Update / re-install

Re-run `install.ps1` any time. It's idempotent: existing config (the
saved username and the persistent agent id) is preserved, files are
overwritten, the task is replaced. Use this whenever you ship a new
agent.js.

## Change the registered username

Either re-run the installer with a new `-Username`, or edit the file
directly:

```
notepad %LocalAppData%\VEAdminAgent\config.json
# Then restart the task:
Stop-ScheduledTask  -TaskName VEAdminAgent
Start-ScheduledTask -TaskName VEAdminAgent
```

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Add `-KeepConfig` if you want to preserve the saved username/URL across a
reinstall:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepConfig
```

## How autostart actually works

The installer registers a per-user **Scheduled Task** (not a Windows
Service). Reasons:

- A Service runs in session 0 and physically can't drive the user's
  cursor without privileged session-switching tricks. The agent has to
  inject mouse/keyboard events into the *user's* desktop, so it has to
  live in the user's session.
- Scheduled Tasks register without admin rights when scoped to the
  current user — important for restricted corporate machines where the
  user can't run installers as admin.
- Tasks support automatic respawn-on-crash (`RestartCount = 3`,
  `RestartInterval = 1 min`) and a "repeat every 5 min if not running"
  rule, so if the agent dies for any reason it's back up within minutes
  with no human intervention.

To inspect the task: `taskschd.msc` → **Task Scheduler Library** →
`VEAdminAgent`.

## Troubleshooting

**"Node.js v20 or later is required" during install**
Install Node from nodejs.org (LTS is fine), close + reopen PowerShell,
re-run the installer. The agent uses ES module top-level await which
requires Node 20+.

**`npm install` fails with code E403**
Your network blocks the public npm registry. Configure an internal
mirror first (`npm config set registry …`) or run `npm install` once on
a permitted network and copy the resulting `node_modules\` into
`%LocalAppData%\VEAdminAgent\`.

**Agent log never shows `[autopair] registered`**
Outbound `wss://` to the signaling server is blocked. Open the URL in
a browser on the same PC — `https://<your-server>/health` should
return `{ok:true, ...}`. If it doesn't, fix the network egress first;
the agent can't help.

**Manager click times out with "agent-offline"**
The username doesn't match. Check `config.json` matches what VE Admin
sends as `targetUser`. The match is case-insensitive and ignores
surrounding whitespace, so `"Aisha Al Mansoori"` and
`"aisha al mansoori"` both work, but `"aisha"` alone won't.

**Antivirus pops up**
Some AV products flag PowerShell calling into `user32.dll` (which is
how the agent moves the mouse). Whitelist
`%LocalAppData%\VEAdminAgent\` and `powershell.exe` started by the
`VEAdminAgent` task.

## Manual run (no installer)

If you just want to test interactively without setting up autostart:

```powershell
cd "<this folder>"
$env:AUTOPAIR_URL  = "https://remote-control-cdqo.onrender.com"
$env:AUTOPAIR_USER = "Aisha Al Mansoori"
npm install
npm start
```

The agent has a built-in first-run wizard: if you don't set
`AUTOPAIR_URL` and there's no `config.json`, it prompts for the values
and saves them to `%LocalAppData%\VEAdminAgent\config.json` itself. After
that, `npm start` alone is enough.
