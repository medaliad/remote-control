@echo off
REM Build "VE Admin Remote Controller.exe" from installer_gui.py.
REM
REM Run this on a Windows PC (in the agent folder containing install.ps1
REM and node_modules). Requires Python 3 on PATH (or via the `py` launcher).
REM
REM Output: dist\VE Admin Remote Controller.exe

setlocal EnableDelayedExpansion

echo.
echo === VE Admin Remote Controller build ===
echo.

REM ---- find a working Python ----
set PY=
where py >nul 2>nul && set PY=py
if "%PY%"=="" (
    where python >nul 2>nul && set PY=python
)
if "%PY%"=="" (
    where python3 >nul 2>nul && set PY=python3
)
if "%PY%"=="" (
    echo [error] No Python found on PATH.
    echo.
    echo   Install Python 3 from https://www.python.org/downloads/
    echo   IMPORTANT: tick the "Add python.exe to PATH" checkbox during install.
    echo.
    pause
    exit /b 1
)
echo [info] using Python launcher: %PY%
%PY% --version
echo.

REM ---- sanity: required source files next to this script ----
REM virtual_eye_logo.png is the wordmark we render in the installer's
REM hero band -- the same logo the Flutter app shows on its login. Missing
REM it isn't fatal at runtime (the GUI falls back to a text wordmark) but
REM we want the build to fail loudly so the shipped EXE always carries it
REM when it's available in the source tree.
for %%F in (installer_gui.py icon.ico install.ps1 agent.js package.json virtual_eye_logo.png) do (
    if not exist "%~dp0%%F" (
        echo [error] %%F is missing from this folder.
        echo         Run build_exe.bat from the agent folder containing install.ps1.
        pause
        exit /b 1
    )
)

echo [..] installing PyInstaller...
%PY% -m pip install --upgrade --quiet pyinstaller
if errorlevel 1 (
    echo [error] pip install failed.
    echo         Try running:  %PY% -m pip install --upgrade pip
    pause
    exit /b 1
)

echo [..] building VE Admin Remote Controller.exe ...
echo       (bundling agent.js, install.ps1, uninstall.ps1, package.json,
echo        package-lock.json, node_modules, helper scripts)
echo.

REM ---- build the --add-data list dynamically so optional files don't fail ----
REM virtual_eye_logo.png is required (sanity-checked above); logo02.png is
REM bundled if present so dev builds with only the older mark still work.
set ADD=--add-data "icon.ico;." ^
        --add-data "virtual_eye_logo.png;." ^
        --add-data "install.ps1;." ^
        --add-data "agent.js;." ^
        --add-data "package.json;." ^
        --add-data "package-lock.json;." ^
        --add-data "node_modules;node_modules"
if exist "%~dp0logo02.png"              set ADD=!ADD! --add-data "logo02.png;."
if exist "%~dp0uninstall.ps1"           set ADD=!ADD! --add-data "uninstall.ps1;."
if exist "%~dp0start-agent.cmd"         set ADD=!ADD! --add-data "start-agent.cmd;."
if exist "%~dp0start-agent-hidden.vbs"  set ADD=!ADD! --add-data "start-agent-hidden.vbs;."
if exist "%~dp0HOW-TO-USE.txt"          set ADD=!ADD! --add-data "HOW-TO-USE.txt;."

%PY% -m PyInstaller ^
    --onefile ^
    --windowed ^
    --name "VE Admin Remote Controller" ^
    --icon icon.ico ^
    !ADD! ^
    --noconfirm ^
    installer_gui.py
if errorlevel 1 (
    echo [error] PyInstaller build failed.
    pause
    exit /b 1
)

echo.
echo [done] Built: dist\VE Admin Remote Controller.exe
echo.
echo Copy that single .exe to any Windows PC and double-click it.
echo It will:
echo   * ask for a username (pre-filled with the OS username or last saved)
echo   * ask for a password (masked, persisted per-user)
echo     -- the signaling server URL is fixed and shown read-only
echo   * pre-clean port 8766 and the old VEAdminAgent task
echo   * install Node.js LTS via winget if missing
echo   * run install.ps1 with -Username and -Password from the form
echo   * register the VEAdminAgent task to auto-start on every login
echo.
pause
endlocal
