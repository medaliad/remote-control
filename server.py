"""
Remote Mouse & Keyboard Control Server
======================================

Runs on the PC you want to control. Serves a web page that another computer
on the same network can open in a browser to move the mouse, click, scroll,
and type.

Usage:
    pip install -r requirements.txt
    python server.py

Then note the URL and PIN printed in the console, open the URL on the
controlling computer's browser, enter the PIN, and go.
"""

import json
import os
import random
import secrets
import socket
import sys
import time
from pathlib import Path

try:
    from flask import Flask, send_from_directory, jsonify, request
    from flask_sock import Sock
    import pyautogui
except ImportError as exc:
    print("Missing dependency:", exc)
    print("Run: pip install -r requirements.txt")
    sys.exit(1)

# --- Config ---------------------------------------------------------------

HOST = "0.0.0.0"          # Listen on all interfaces so LAN clients can reach us
PORT = 5000
PIN_LENGTH = 6

# Speed up pyautogui (default adds a 0.1s pause after every call -> laggy)
pyautogui.PAUSE = 0
pyautogui.FAILSAFE = False  # Don't abort if mouse hits a screen corner

# Sensitivity multiplier for relative mouse movement from the client trackpad
MOVE_SENSITIVITY = 1.5
SCROLL_SENSITIVITY = 1

# --- App setup ------------------------------------------------------------

app = Flask(__name__, static_folder=str(Path(__file__).parent / "static"))
sock = Sock(app)

# Generate a fresh PIN each time the server starts
SERVER_PIN = "".join(str(random.randint(0, 9)) for _ in range(PIN_LENGTH))

# Track authenticated sessions via short-lived tokens
_AUTH_TOKENS: dict[str, float] = {}
TOKEN_TTL_SECONDS = 60 * 60 * 8  # 8 hours


def _issue_token() -> str:
    token = secrets.token_urlsafe(24)
    _AUTH_TOKENS[token] = time.time() + TOKEN_TTL_SECONDS
    return token


def _token_valid(token: str | None) -> bool:
    if not token:
        return False
    expires = _AUTH_TOKENS.get(token)
    if not expires:
        return False
    if time.time() > expires:
        _AUTH_TOKENS.pop(token, None)
        return False
    return True


def _local_ip() -> str:
    """Best-effort detection of this machine's LAN IP."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't actually send packets; just picks the outbound interface
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# --- Routes ---------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    pin = str(data.get("pin", "")).strip()
    if pin != SERVER_PIN:
        # Tiny delay to slow brute-force attempts
        time.sleep(0.5)
        return jsonify({"ok": False, "error": "Invalid PIN"}), 401
    token = _issue_token()
    return jsonify({"ok": True, "token": token})


# --- Input dispatch -------------------------------------------------------

def _handle_event(event: dict) -> None:
    etype = event.get("type")
    if etype == "move":
        dx = float(event.get("dx", 0)) * MOVE_SENSITIVITY
        dy = float(event.get("dy", 0)) * MOVE_SENSITIVITY
        if dx or dy:
            pyautogui.moveRel(dx, dy, duration=0)

    elif etype == "click":
        button = event.get("button", "left")
        if button not in ("left", "right", "middle"):
            return
        double = bool(event.get("double", False))
        if double:
            pyautogui.doubleClick(button=button)
        else:
            pyautogui.click(button=button)

    elif etype == "mousedown":
        button = event.get("button", "left")
        if button in ("left", "right", "middle"):
            pyautogui.mouseDown(button=button)

    elif etype == "mouseup":
        button = event.get("button", "left")
        if button in ("left", "right", "middle"):
            pyautogui.mouseUp(button=button)

    elif etype == "scroll":
        amount = int(float(event.get("amount", 0)) * SCROLL_SENSITIVITY)
        if amount:
            pyautogui.scroll(amount)

    elif etype == "text":
        text = str(event.get("text", ""))
        if text:
            # interval=0 is fastest; pyautogui handles unicode via clipboard is unreliable,
            # so we stick to typewrite which supports ASCII + common punctuation.
            try:
                pyautogui.typewrite(text, interval=0)
            except Exception:
                # Fall back: press keys one at a time, skipping unsupported chars
                for ch in text:
                    try:
                        pyautogui.typewrite(ch, interval=0)
                    except Exception:
                        pass

    elif etype == "key":
        # Accept either a single key ("enter") or a hotkey combo list
        # ("ctrl", "c") via the "combo" field.
        combo = event.get("combo")
        if combo and isinstance(combo, list):
            keys = [str(k) for k in combo if isinstance(k, str)]
            if keys:
                pyautogui.hotkey(*keys)
            return
        key = event.get("key")
        if isinstance(key, str) and key:
            pyautogui.press(key)


# --- WebSocket ------------------------------------------------------------

@sock.route("/ws")
def ws(ws):
    """Handle a single client connection.

    The first message must be {"type": "auth", "token": "..."}.
    After that, input events stream in.
    """
    authed = False
    while True:
        msg = ws.receive()
        if msg is None:
            return
        try:
            event = json.loads(msg)
        except ValueError:
            continue

        if not authed:
            if event.get("type") == "auth" and _token_valid(event.get("token")):
                authed = True
                ws.send(json.dumps({"type": "auth_ok"}))
            else:
                ws.send(json.dumps({"type": "auth_fail"}))
                return
            continue

        try:
            _handle_event(event)
        except Exception as exc:
            # Don't kill the connection on a single bad event
            ws.send(json.dumps({"type": "error", "message": str(exc)}))


# --- Main -----------------------------------------------------------------

def _print_banner() -> None:
    ip = _local_ip()
    url_local = f"http://localhost:{PORT}"
    url_lan = f"http://{ip}:{PORT}"
    bar = "=" * 62
    print(bar)
    print("  REMOTE MOUSE CONTROL SERVER")
    print(bar)
    print(f"  PIN:           {SERVER_PIN}")
    print(f"  On this PC:    {url_local}")
    print(f"  From another:  {url_lan}")
    print(bar)
    print("  1. Make sure both computers are on the same WiFi/network.")
    print("  2. Open the LAN URL above in a browser on the other computer.")
    print("  3. Enter the PIN when prompted.")
    print("  Press Ctrl+C to stop the server.")
    print(bar)


if __name__ == "__main__":
    _print_banner()
    # Use threaded=True so websocket + HTTP requests don't block each other.
    app.run(host=HOST, port=PORT, threaded=True, debug=False, use_reloader=False)
