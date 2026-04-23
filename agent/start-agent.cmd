@echo off
rem ---------------------------------------------------------------------------
rem  start-agent.cmd -- Launch the local mouse-injection agent on Windows.
rem
rem  Put a SHORTCUT to this file in your Windows Startup folder so the agent
rem  runs every time you log in:
rem
rem      1. Press Win+R
rem      2. Type   shell:startup   then press Enter
rem      3. Drag a shortcut to this file (start-agent.cmd) into that folder.
rem
rem  On next login the agent is already running in the background, so when you
rem  open the Host page from Render and toggle "Allow remote input", the page
rem  connects to ws://127.0.0.1:8766 immediately -- no manual `npm start` each
rem  session.
rem
rem  Change ALLOWED_ORIGIN below if your Render URL is different. With this
rem  set, the agent rejects WebSocket upgrades whose Origin doesn't match --
rem  even a malicious tab open locally can't drive your cursor unless it came
rem  from your Render page.
rem ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

rem Your deployed Host page. The agent only accepts connections from here.
if not defined ALLOWED_ORIGIN (
  set "ALLOWED_ORIGIN=https://remote-control-cdqo.onrender.com"
)

rem Install deps if this is the first run (idempotent after that).
if not exist "node_modules" (
  echo [start-agent] first run -- installing dependencies...
  call npm install
)

echo [start-agent] Allowed origin: %ALLOWED_ORIGIN%
echo [start-agent] Launching agent on ws://127.0.0.1:8766
call npm start

endlocal
