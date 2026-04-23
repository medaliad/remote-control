#!/usr/bin/env bash
# uninstall.sh — removes the auto-start hook and stops the agent.
# Leaves the repo and node_modules intact; delete the folder yourself if you
# also want those gone. Safe to re-run.
set -euo pipefail

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/io.remote-control.host.plist"
    if [ -f "$PLIST" ]; then
      info "Unloading and removing $PLIST"
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
    else
      info "No launchd plist found — nothing to unload."
    fi
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/remote-control.service"
    if [ -f "$UNIT" ]; then
      info "Disabling and removing $UNIT"
      systemctl --user disable --now remote-control.service 2>/dev/null || true
      rm -f "$UNIT"
      systemctl --user daemon-reload
    else
      info "No systemd unit found — nothing to disable."
    fi
    ;;
  *)
    echo "Unsupported OS: $(uname -s). Windows users: delete %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\'Remote Control Host.lnk'" >&2
    exit 1
    ;;
esac

info "Done. The agent will no longer auto-start."
