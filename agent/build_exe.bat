@echo off
REM Build "VE Admin Remote Controller.exe" from installer_gui.py.
REM
REM Run this on a Windows machine, in the agent folder (the one that contains
REM install.ps1, agent.js, package.json, node_modules, etc.). It bundles all
REM the agent files into a single self-contained .exe.
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
    echo   Then close this window, open a new Command Prompt, and run build_exe.bat again.
    echo.
    pause
    exit /b 1
)
echo [info] using Python launcher: %PY%
%PY% --version
echo.

REM ---- sanity: required files next to this script ----
for %%F in (installer_gui.py icon.ico install.ps1 agent.js package.json) do (
    if not exist "%~dp0%%F" (
        echo [error] %%F is missing from this folder.
        echo         Run build_exe.bat from the agent folder that contains all the source files.
        pause
        exit /b 1
    )
)

echo [..] installing PyInstaller...
%PY% -m pip install --upgrade --quiet pyinstaller
if errorlevel 1 (
    echo [error] pip install pyinstaller failed.
    echo         Try running:  %PY% -m pip install --upgrade pip
    echo         then re-run this script.
    pause
    exit /b 1
)

echo [..] building VE Admin Remote Controller.exe ...
echo       (bundling agent.js, install.ps1, uninstall.ps1, package.json,
echo        package-lock.json, node_modules, helper scripts)
echo.

REM ---- build the --add-data list dynamically so optional files don't fail ----
set ADD=--add-data "icon.ico;." ^
        --add-data "install.ps1;." ^
        --add-data "agent.js;." ^
        --add-data "package.json;." ^
        --add-data "package-lock.json;." ^
        --add-data "node_modules;node_modules"
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
echo   * pre-clean port 8766
echo   * install Node.js LTS via winget if missing
echo   * ask for the username
echo   * run install.ps1 and start the agent
echo   * register the VEAdminAgent task to auto-start on every login
echo.
pause
endlocal
