@echo off
setlocal

REM ---------------------------------------------------------------------------
REM Launches everything the HOST machine needs in three separate terminals:
REM
REM   1. The signaling server (server/)   -- brokers the code + WebRTC SDPs.
REM   2. The local input agent (agent/)   -- injects mouse + keyboard via
REM                                           PowerShell/user32.dll.
REM   3. The web dev server (web/)        -- serves the Host + Client pages.
REM
REM After it starts the three terminals, it opens the Host page in your
REM default browser. Click "Create session" and share the code with the
REM remote viewer.
REM
REM If you see a tiny cursor jiggle a second after the agent window pops up,
REM OS injection works. If you DON'T see a jiggle, your antivirus or UAC is
REM blocking PowerShell's user32 calls -- that's the root cause and no
REM amount of code changes will fix it.
REM ---------------------------------------------------------------------------

set ROOT=%~dp0
cd /d "%ROOT%"

echo.
echo === Installing dependencies (skip if already installed) ===
echo.
if not exist "agent\node_modules\ws" (
  pushd agent && call npm install && popd
)
if not exist "server\node_modules" (
  pushd server && call npm install && popd
)
if not exist "web\node_modules" (
  pushd web && call npm install && popd
)

echo.
echo === Starting agent, server, and web ===
echo.

start "remote-control: agent"  cmd /k "cd /d %ROOT%agent  && npm start"
start "remote-control: server" cmd /k "cd /d %ROOT%server && npm run dev"
start "remote-control: web"    cmd /k "cd /d %ROOT%web    && npm run dev"

REM Give Vite a moment to come up before opening the browser.
timeout /t 5 /nobreak >nul

start "" "http://localhost:5173/#/host"

echo.
echo All three processes are running in their own windows. Close a window
echo to stop that piece. Re-run this script any time to start them again.
echo.
echo If the cursor did NOT jiggle in the "remote-control: agent" window,
echo your Windows is blocking PowerShell's user32 calls. Open the agent
echo window in a terminal run as Administrator, or add an antivirus
echo exclusion for %ROOT%agent\
echo.
