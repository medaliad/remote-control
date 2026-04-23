#!/usr/bin/env bash
# install.sh — one-shot installer for the Remote Control host (macOS + Linux).
#
# Run with:
#   curl -fsSL https://your.intranet/install.sh | bash
# or from a cloned repo:
#   ./scripts/install.sh
#
# What it does:
#   1. Verifies Node.js >= 18 is on PATH (installs nothing on its own — we don't
#      want a single curl|bash to silently drop a Node runtime; the message tells
#      the user what to do).
#   2. Runs `npm ci` then `npm run build:combined` inside the repo.
#   3. Registers auto-start:
#        • macOS  → ~/Library/LaunchAgents/io.remote-control.host.plist
#        • Linux  → ~/.config/systemd/user/remote-control.service + enable
#   4. Starts the service.
#   5. Opens the host page in the default browser.
#
# This script is idempotent — safe to re-run to update the install.

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT="${PORT:-3000}"
DEVICE_NAME="${DEVICE_NAME:-}"
RELAY_URL="${RELAY_URL:-}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m==>\033[0m %s\n' "$*"; }
die()   { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Preflight ──────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js is required. Install from https://nodejs.org (LTS) and re-run."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js >= 18 required (found $(node -v))."
fi
command -v npm >/dev/null 2>&1 || die "npm is required (comes with Node.js)."

[ -f "$REPO_DIR/package.json" ] || die "package.json not found at $REPO_DIR — is this the repo root?"

# ── 2. Dependencies + build ───────────────────────────────────────────────────
info "Installing npm dependencies (this can take a minute)…"
( cd "$REPO_DIR" && npm ci --no-audit --no-fund )

info "Building the web UI…"
( cd "$REPO_DIR" && npm run build:combined )

# ── 3. Auto-start registration ────────────────────────────────────────────────
NODE_BIN="$(command -v node)"
LAUNCHER="$REPO_DIR/bin/rc-host.mjs"
[ -f "$LAUNCHER" ] || die "Launcher not found: $LAUNCHER"

UNAME_S="$(uname -s)"
case "$UNAME_S" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/io.remote-control.host.plist"
    mkdir -p "$(dirname "$PLIST")"
    info "Writing launchd plist → $PLIST"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>io.remote-control.host</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${LAUNCHER}</string>
  </array>
  <key>WorkingDirectory</key> <string>${REPO_DIR}</string>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>StandardOutPath</key>  <string>${REPO_DIR}/rc-host.log</string>
  <key>StandardErrorPath</key><string>${REPO_DIR}/rc-host.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>           <string>${PORT}</string>
    <key>NO_BROWSER</key>     <string>1</string>
    $( [ -n "$DEVICE_NAME" ] && printf '<key>DEVICE_NAME</key><string>%s</string>' "$DEVICE_NAME" )
    $( [ -n "$RELAY_URL"   ] && printf '<key>RELAY_URL</key><string>%s</string>'   "$RELAY_URL"   )
  </dict>
</dict>
</plist>
EOF
    launchctl unload  "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
    info "launchd service loaded. It will start at every login."
    ;;

  Linux)
    UNIT="$HOME/.config/systemd/user/remote-control.service"
    mkdir -p "$(dirname "$UNIT")"
    info "Writing systemd --user unit → $UNIT"
    cat > "$UNIT" <<EOF
[Unit]
Description=Remote Control host agent
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
Environment=PORT=${PORT}
Environment=NO_BROWSER=1
$( [ -n "$DEVICE_NAME" ] && printf 'Environment=DEVICE_NAME=%s\n' "$DEVICE_NAME" )
$( [ -n "$RELAY_URL"   ] && printf 'Environment=RELAY_URL=%s\n'   "$RELAY_URL"   )
ExecStart=${NODE_BIN} ${LAUNCHER}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now remote-control.service
    info "systemd --user service started. Logs: journalctl --user -u remote-control"
    # Optional: enable lingering so it survives logout (requires sudo).
    if command -v loginctl >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
      warn "Tip: run 'sudo loginctl enable-linger $USER' so the agent runs even when you're logged out."
    fi
    ;;

  *)
    die "Unsupported OS: $UNAME_S. Windows users should run scripts\\install.ps1."
    ;;
esac

# ── 4. Open the browser on the host page ──────────────────────────────────────
URL="http://localhost:${PORT}/host"
sleep 2
if   command -v open     >/dev/null 2>&1; then open      "$URL" || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open  "$URL" >/dev/null 2>&1 || true
fi

bold ""
bold "✓ Remote Control host installed."
bold "  It will auto-start on login. Dashboard: $URL"
bold ""
