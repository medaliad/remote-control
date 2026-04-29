@echo off
rem ===========================================================================
rem  Diagnose.cmd
rem
rem  Run this on the PC where you expect the agent to be live. It prints
rem  everything needed to figure out why the host page says
rem  "local agent is offline":
rem
rem    1. The PC's hostname (so you can confirm you're on the controlled PC).
rem    2. Whether the VEAdminAgent Scheduled Task is registered + running.
rem    3. Whether anything is listening on the agent's WebSocket port 8766.
rem    4. The current saved config (URL, username, allowedOrigin).
rem    5. The last 40 lines of agent.log.
rem
rem  Double-click it. Read the output. Send a screenshot if you want help.
rem ===========================================================================

setlocal EnableDelayedExpansion

echo.
echo ============================================================
echo   VE Admin Agent - Diagnostics
echo ============================================================
echo.

echo [1] PC hostname
echo     ------------
echo     This PC : %COMPUTERNAME%
echo     User    : %USERNAME%
echo.
echo     The host page MUST be opened on this same PC. If you
echo     opened the https://...#/host?token=... link on a
echo     different computer, the local agent here cannot help.
echo.

echo [2] Scheduled task
echo     ---------------
powershell -NoProfile -Command "try { $t = Get-ScheduledTask -TaskName VEAdminAgent -ErrorAction Stop; $i = $t | Get-ScheduledTaskInfo; Write-Host '     State        :' $t.State; Write-Host '     LastRunTime  :' $i.LastRunTime; Write-Host '     LastResult   :' ('0x{0:X}' -f $i.LastTaskResult); Write-Host '     NextRunTime  :' $i.NextRunTime } catch { Write-Host '     NOT REGISTERED. Run Setup.cmd first.' -ForegroundColor Yellow }"
echo.

echo [3] Port 8766 ^(local WebSocket the host page connects to^)
echo     ---------------------------------------------------
powershell -NoProfile -Command "$c = Test-NetConnection -ComputerName 127.0.0.1 -Port 8766 -WarningAction SilentlyContinue -InformationLevel Quiet; if ($c) { Write-Host '     OK - something IS listening on 127.0.0.1:8766.' -ForegroundColor Green } else { Write-Host '     FAIL - nothing is listening on 127.0.0.1:8766.' -ForegroundColor Yellow; Write-Host '            The agent is not running on THIS PC. See [2] above.' }"
echo.
echo     Process holding the port ^(if any^):
for /f "tokens=*" %%L in ('netstat -ano ^| findstr ":8766" ^| findstr "LISTENING"') do (
  echo       %%L
)
echo.

echo [4] Saved config ^(%%LOCALAPPDATA%%\VEAdminAgent\config.json^)
echo     ----------------------------------------------------
if exist "%LOCALAPPDATA%\VEAdminAgent\config.json" (
  powershell -NoProfile -Command "$c = Get-Content -Raw '%LOCALAPPDATA%\VEAdminAgent\config.json' | ConvertFrom-Json; Write-Host '     autopairUser  :' $c.autopairUser; Write-Host '     autopairUrl   :' $c.autopairUrl; Write-Host '     allowedOrigin :' $c.allowedOrigin; if ($c.allowedOrigin -ne $c.autopairUrl) { Write-Host '     WARNING: allowedOrigin and autopairUrl differ - the host page Origin check may reject the browser. Re-run Setup.cmd to fix.' -ForegroundColor Yellow }"
) else (
  echo     NOT FOUND. Run Setup.cmd first.
)
echo.

echo [5] Last 40 lines of agent.log
echo     ---------------------------
if exist "%LOCALAPPDATA%\VEAdminAgent\agent.log" (
  powershell -NoProfile -Command "Get-Content -Tail 40 '%LOCALAPPDATA%\VEAdminAgent\agent.log' | ForEach-Object { '     ' + $_ }"
) else (
  echo     No log file yet at %LOCALAPPDATA%\VEAdminAgent\agent.log
)
echo.

echo ============================================================
echo   What the output should look like when things are healthy
echo ============================================================
echo   [2] State = Running
echo   [3] OK - something IS listening on 127.0.0.1:8766.
echo   [4] allowedOrigin = https://remote-control-cdqo.onrender.com
echo   [5] log contains:
echo         [agent] WebSocket ready at ws://127.0.0.1:8766
echo         [agent] Origin allowlist: https://remote-control-cdqo.onrender.com
echo         [autopair] registered ^(user="..."^)
echo.
echo   If [3] fails, the agent process is NOT running on this PC.
echo     Fix: re-run Setup.cmd, or
echo          Start-ScheduledTask -TaskName VEAdminAgent
echo.
echo   If [3] is OK but the host page still says "agent offline",
echo   the most likely cause is that the host URL was opened on
echo   a DIFFERENT computer than this one. The agent only listens
echo   on loopback ^(127.0.0.1^), so the browser viewing the host
echo   page must be running on this same PC ^(%COMPUTERNAME%^).
echo ============================================================
echo.
pause
endlocal
