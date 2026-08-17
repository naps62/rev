#!/usr/bin/env bash
# Build the web UI and install rev as an always-on user service:
# systemd on Linux, launchd on macOS. Idempotent — safe to re-run after a
# git pull to pick up changes. Pass --no-hooks to skip the Claude Code hooks.
set -euo pipefail
cd "$(dirname "$0")/.."
CHECKOUT=$PWD

WITH_HOOKS=1
[[ "${1:-}" == "--no-hooks" ]] && WITH_HOOKS=0

PORT="${REV_PORT:-7373}"
LABEL=com.naps62.rev

die() { printf 'install: %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found. $2"; }

need git "Install Xcode Command Line Tools (xcode-select --install) or your distro's git."
need python3 "Install Python 3 (Xcode Command Line Tools provide it on macOS)."

. "$CHECKOUT/scripts/service-lib.sh"
rev_resolve_node

# A release tarball ships a prebuilt rev.js and no sources; only a git checkout
# has to install deps and build the UI.
if [[ -f "$CHECKOUT/rev.js" ]]; then
  ENTRY=rev.js
else
  ENTRY=server/index.ts
  rev_ensure_pnpm
fi

# A foreign process on the port would make the service flap on restart.
if curl -sf --max-time 2 "http://localhost:$PORT/api/repos" >/dev/null 2>&1; then
  echo "install: something already answers on :$PORT (an older rev? it will be replaced)"
elif command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "port $PORT is taken by another process. Free it, or set REV_PORT."
fi

# -------------------------------------------------------------------- build

if [[ "$ENTRY" == server/index.ts ]]; then
  pnpm install
  pnpm run build
fi

# ------------------------------------------------------------------ service

install_launchd() {
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  local uid; uid=$(id -u)

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  rev_render "$CHECKOUT/launchd/$LABEL.plist.template" "$plist" 1

  # bootout first so a re-run picks up a changed plist; ignore "not loaded".
  launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$plist" ||
    launchctl load -w "$plist"   # older macOS
  launchctl kickstart -k "gui/$uid/$LABEL" 2>/dev/null || true

  echo "logs: $HOME/Library/Logs/rev.log  (launchctl print gui/$uid/$LABEL for status)"
}

install_systemd() {
  # See deploy.sh for REV_SKIP_UNIT_INSTALL.
  if [ "${REV_SKIP_UNIT_INSTALL:-0}" = 1 ]; then
    echo "install: REV_SKIP_UNIT_INSTALL=1, leaving unit files to the config manager"
    systemctl --user restart rev.service
    loginctl enable-linger "$USER" >/dev/null 2>&1 || true
    return
  fi
  mkdir -p ~/.config/systemd/user
  rev_render "$CHECKOUT/systemd/rev.service.template" ~/.config/systemd/user/rev.service 0
  systemctl --user daemon-reload
  systemctl --user enable --now rev.service
  systemctl --user restart rev.service
  # survive logout
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
  systemctl --user --no-pager status rev.service || true
}

case "$(uname -s)" in
  Darwin) install_launchd ;;
  Linux)  install_systemd ;;
  *)      die "unsupported OS $(uname -s); run 'pnpm start' yourself." ;;
esac

# -------------------------------------------------------------------- hooks

if (( WITH_HOOKS )); then
  REV_CHECKOUT="$CHECKOUT" ./scripts/install-hooks.sh
fi

# ------------------------------------------------------------------- verify

for _ in $(seq 1 20); do
  curl -sf --max-time 2 "http://localhost:$PORT/api/repos" >/dev/null 2>&1 && break
  sleep 1
done

echo
if curl -sf --max-time 2 "http://localhost:$PORT/api/repos" >/dev/null 2>&1; then
  echo "rev is up: http://localhost:$PORT"
  echo "Loopback only. To reach it from other machines (no auth — trusted networks only):"
  echo "  mkdir -p ~/.config/rev && echo REV_HOST=0.0.0.0 >> ~/.config/rev/env   # then restart the service"
else
  die "service installed but nothing answers on :$PORT yet — check the logs above."
fi
