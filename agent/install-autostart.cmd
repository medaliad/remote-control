@echo off
rem ===========================================================================
rem  install-autostart.cmd
rem
rem  ONE-TIME SETUP. Run this file once by double-clicking it.
rem  After that, the remote-control agent starts automatically on every
rem  Windows login -- silently, in the background, with no window.
rem
rem  What this script does:
rem    1. Installs Node.js dependencies in the agent folder (if not yet done)
rem    2. Creates a shortcut in your Windows Startup folder that points to
rem       start-agent-hidden.vbs
rem    3. Starts the agent immediately so you don't have to reboot
rem
rem  After this, you can close this window and forget about it.
rem  The agent runs forever (until you stop it or uninstall it).
rem
rem  To undo: delete the "Remote Control Agent.lnk" shortcut from your
rem  Startup folder (Win+R -> shell:startup).
rem ===========================================================================

setlocal
cd /d "%~dp0"

echo.
echo =========================================================
echo  Remote Control Agent - Auto-Start Installer
echo =========================================================
echo.

rem ---------------------------------------------------------------------------
rem Step 1: Check Node.js is installed
rem ---------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo.
  echo  Please install Node.js 20 or later from https://nodejs.org
  echo  Then run this installer again.
  echo.
  pause
  exit /b 1
)
echo [1/4] Node.js found:
node --version

rem ---------------------------------------------------------------------------
rem Step 2: Install npm dependencies (idempotent)
rem ---------------------------------------------------------------------------
if not exist "node_modules" (
  echo.
  echo [2/4] Installing dependencies (first run only, takes ~30 seconds)...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo [2/4] Dependencies already installed.
)

rem ---------------------------------------------------------------------------
rem Step 3: Create Startup folder shortcut pointing to start-agent-hidden.vbs
rem ---------------------------------------------------------------------------
echo.
echo [3/4] Creating Startup folder shortcut...

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP%\Remote Control Agent.lnk"
set "TARGET=%~dp0start-agent-hidden.vbs"

rem Use PowerShell to create the .lnk file (no third-party tools needed).
powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%'); " ^
  "$s.TargetPath = '%TARGET%'; " ^
  "$s.WorkingDirectory = '%~dp0'; " ^
  "$s.WindowStyle = 7; " ^
  "$s.Description = 'Auto-start the remote control agent on Windows login'; " ^
  "$s.Save()"

if exist "%SHORTCUT%" (
  echo       Shortcut created at:
  echo       %SHORTCUT%
) else (
  echo [ERROR] Failed to create Startup shortcut.
  pause
  exit /b 1
)

rem ---------------------------------------------------------------------------
rem Step 4: Start the agent right now (silently) so you don't need to reboot
rem ---------------------------------------------------------------------------
echo.
echo [4/4] Starting the agent in the background...

rem Kill any already-running instance first (so this install is clean).
taskkill /F /IM node.exe >nul 2>nul

rem Launch the hidden .vbs -- runs fully detached with no window.
wscript.exe "%~dp0start-agent-hidden.vbs"

echo       Agent started. It is now running silently in the background.
echo       Log file: %TEMP%\remote-access-agent.log

echo.
echo =========================================================
echo  DONE! Setup complete.
echo =========================================================
echo.
echo  What happens now:
echo    - The agent is running RIGHT NOW in the background.
echo    - On every future Windows login, it will auto-start silently.
echo    - You never need to run this installer again.
echo.
echo  How to use it:
echo    1. On THIS computer (the one being controlled), open:
echo       https://remote-control-cdqo.onrender.com/#/host
echo    2. Click "Allow remote input" ON.
echo    3. From any other device, open:
echo       https://remote-control-cdqo.onrender.com/#/client
echo       and enter the code shown on the Host page.
echo.
echo  To stop the agent: open Task Manager, end "node.exe".
echo  To uninstall auto-start: delete the shortcut from
echo       %STARTUP%
echo.
pause
endlocal
