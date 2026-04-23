@echo off
REM Remote Mouse Server launcher (Windows)
REM First run: installs dependencies into a local venv.
REM Subsequent runs: just starts the server.

setlocal
cd /d "%~dp0"

if not exist ".venv\" (
    echo Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo.
        echo ERROR: Python was not found. Install Python 3.10+ from python.org
        echo and tick "Add Python to PATH" during install.
        pause
        exit /b 1
    )
    echo Installing dependencies...
    call ".venv\Scripts\python.exe" -m pip install --upgrade pip
    call ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

echo.
call ".venv\Scripts\python.exe" server.py
pause
