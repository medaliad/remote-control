@echo off
rem ===========================================================================
rem  Setup.cmd
rem
rem  ONE-CLICK installer for the VE Admin remote-control agent.
rem
rem  HOW TO USE (for non-developers):
rem    1. Double-click this file.
rem    2. If Windows asks for permission during Node.js install, click Yes.
rem    3. Type the username this PC should register as (e.g. dali) and OK.
rem    4. Wait for "ALL DONE!" and close the window.
rem
rem  WHAT IT DOES:
rem    [1/3] Checks for Node.js. If missing, installs it via winget
rem          (or opens the download page as a fallback).
rem    [2/3] Pops up a small box asking for the username.
rem    [3/3] Runs install.ps1, which copies the agent to
rem          %LocalAppData%\VEAdminAgent\, registers a Scheduled Task that
rem          auto-starts the agent at every login (hidden, auto-respawn),
rem          and starts it now.
rem
rem  No admin rights are required for the agent itself. Windows may ask
rem  for permission only during the Node.js install step.
rem
rem  To change the username later: re-run this Setup.cmd, or edit
rem    %LocalAppData%\VEAdminAgent\config.json
rem  and run:  Stop-ScheduledTask -TaskName VEAdminAgent ;
rem            Start-ScheduledTask -TaskName VEAdminAgent
rem ===========================================================================

setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   VE Admin Remote Agent - One-Click Setup
echo ============================================================
echo.

rem ---------------------------------------------------------------------------
rem  Sanity: make sure the supporting files are next to this script.
rem ---------------------------------------------------------------------------
if not exist "%~dp0install.ps1" (
  echo [ERROR] install.ps1 was not found next to Setup.cmd.
  echo         Make sure Setup.cmd is in the same folder as install.ps1
  echo         and agent.js, then double-click it again.
  echo.
  pause
  exit /b 1
)
if not exist "%~dp0agent.js" (
  echo [ERROR] agent.js was not found next to Setup.cmd.
  echo         Make sure Setup.cmd is in the same folder as the agent files.
  echo.
  pause
  exit /b 1
)

rem ---------------------------------------------------------------------------
rem  Step 1: Pre-flight cleanup.
rem
rem  If the user previously launched the agent manually (npm start in a cmd
rem  window) or via the legacy install-autostart.cmd, an orphan node.exe is
rem  still squatting on 127.0.0.1:8766 and will block the new install from
rem  binding. We kill anything listening on that port and remove the old
rem  Startup-folder shortcut so Setup.cmd is the single source of truth
rem  going forward.
rem ---------------------------------------------------------------------------
echo [1/4] Cleaning up any previous agent process on port 8766...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue; if ($c) { foreach ($x in $c) { try { Stop-Process -Id $x.OwningProcess -Force -ErrorAction Stop; Write-Host '       killed previous agent (PID' $x.OwningProcess ')' } catch { Write-Host '       could not kill PID' $x.OwningProcess '- continuing anyway' } } } else { Write-Host '       no previous agent on port 8766' }"

rem Stop and remove the existing scheduled task so we start clean.
powershell -NoProfile -Command "try { Stop-ScheduledTask -TaskName VEAdminAgent -ErrorAction SilentlyContinue } catch {}"

rem Remove the legacy "Remote Control Agent.lnk" shortcut so we don't end up
rem with two different autostart mechanisms running side by side.
set "OLD_LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Remote Control Agent.lnk"
if exist "%OLD_LNK%" (
  del /q "%OLD_LNK%" >nul 2>nul
  echo        removed legacy Startup-folder shortcut
)
echo.

rem ---------------------------------------------------------------------------
rem  Step 2: Make sure Node.js (v20+) is installed.
rem ---------------------------------------------------------------------------
set "NODE_OK=0"
where node >nul 2>nul
if not errorlevel 1 (
  for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
  echo [2/4] Node.js found: !NODEVER!
  set "NODE_OK=1"
)

if "!NODE_OK!"=="0" (
  echo [2/4] Node.js is not installed. Trying to install it for you...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  This PC does not have winget, so I cannot auto-install Node.js.
    echo  Opening the Node.js download page now. Please:
    echo    1. Click the LTS Installer link on that page.
    echo    2. Run the .msi and click Next / Next / Finish.
    echo    3. Re-run THIS file ^(Setup.cmd^) when it finishes.
    echo.
    start "" "https://nodejs.org/en/download"
    pause
    exit /b 1
  )
  echo       Installing Node.js LTS via winget. This can take 1-2 minutes...
  echo       Click "Yes" if Windows asks for permission.
  rem We don't trust winget's exit code on its own: it returns non-zero for
  rem "already installed" too. The real test is whether `node --version`
  rem works after we refresh PATH below.
  winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  rem Refresh PATH so the freshly-installed node.exe is visible to this shell
  rem without needing a reboot or a new cmd window.
  call :refresh_path
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  Node.js still isn't accessible. winget may have failed, or the
    echo  install needs a fresh window to pick up PATH. Please install
    echo  Node.js LTS manually from https://nodejs.org, then close this
    echo  window and re-run Setup.cmd.
    start "" "https://nodejs.org/en/download"
    pause
    exit /b 1
  )
  for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
  echo       Node.js installed: !NODEVER!
)

rem ---------------------------------------------------------------------------
rem  Step 3: Ask for the username via a small dialog box.
rem
rem  The default shown in the box is the smartest one we can compute:
rem    - if this PC was set up before, we re-use the previously saved
rem      username from %LocalAppData%\VEAdminAgent\config.json so the user
rem      can just press OK to keep it;
rem    - otherwise we fall back to the Windows username.
rem ---------------------------------------------------------------------------
echo.
echo [3/4] A small dialog box has just opened. Type the username this PC
echo       should register as ^(for example: dali^), then click OK.
echo       If a name is already filled in from a previous setup, just
echo       press OK to keep it.

set "USER_INPUT="
for /f "delims=" %%u in ('powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; $cfg = Join-Path $env:LOCALAPPDATA 'VEAdminAgent\config.json'; $default = $env:USERNAME; if (Test-Path $cfg) { try { $saved = (Get-Content -Raw $cfg | ConvertFrom-Json).autopairUser; if ($saved) { $default = [string]$saved } } catch {} }; $u = [Microsoft.VisualBasic.Interaction]::InputBox('Enter the VE Admin username this PC should register as. Examples: dali, aisha, ahmed', 'VE Admin Agent - Setup', $default); [Console]::Out.Write($u)"') do set "USER_INPUT=%%u"

if "!USER_INPUT!"=="" (
  echo.
  echo  No username entered. Setup cancelled.
  pause
  exit /b 1
)
echo       Will register this PC as: !USER_INPUT!

rem ---------------------------------------------------------------------------
rem  Step 4: Run the PowerShell installer with that username.
rem ---------------------------------------------------------------------------
echo.
echo [4/4] Installing the agent and registering it to auto-start...
echo.

powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1" -ServerUrl "https://remote-control-cdqo.onrender.com" -Username "!USER_INPUT!" -AllowedOrigin "https://remote-control-cdqo.onrender.com" -NonInteractive
if errorlevel 1 (
  echo.
  echo  Setup failed. Read the messages above for details. Common causes:
  echo    - Network blocks the npm registry or the signaling server.
  echo    - Antivirus blocked PowerShell from registering the task.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   ALL DONE!
echo ============================================================
echo   The agent is running NOW and will auto-start on every
echo   login to this PC.
echo.
echo   Registered as : !USER_INPUT!
echo   Logs          : %%LOCALAPPDATA%%\VEAdminAgent\agent.log
echo   Task          : Task Scheduler -^> VEAdminAgent
echo ============================================================
echo.
echo   TO USE THIS PC IN A REMOTE SESSION
echo   ----------------------------------
echo   On any OTHER computer ^(your laptop, phone, another PC^):
echo     1. Open a browser ^(Chrome, Edge, Safari, ...^).
echo     2. Go to VE Admin and log in.
echo     3. Click "Open Session" against the user "!USER_INPUT!".
echo   This PC's screen will come online automatically. No code
echo   to type, no extra setup on the other computer.
echo.
echo   TO SET UP ANOTHER TEAMMATE'S PC
echo   -------------------------------
echo   1. Copy this whole "agent" folder to their PC ^(USB stick,
echo      shared drive, email a zip, ...^).
echo   2. On their PC, double-click Setup.cmd in that folder.
echo   3. Type THEIR username ^(e.g. aisha, ahmed^) when the box
echo      asks, and click OK.
echo   That PC is then reachable too. Repeat per teammate.
echo.
echo   See HOW-TO-USE.txt in this folder for a friendlier copy
echo   of these instructions.
echo ============================================================
echo.
pause
endlocal
exit /b 0


:refresh_path
rem Re-read PATH from the registry so a freshly-installed Node.js becomes
rem visible to the rest of this script without needing a reboot or a new
rem cmd window. We rebuild PATH from the system + user values just like
rem Windows does on logon.
set "USER_PATH="
set "SYS_PATH="
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%b"
if defined SYS_PATH set "PATH=!SYS_PATH!"
if defined USER_PATH set "PATH=!PATH!;!USER_PATH!"
goto :eof
