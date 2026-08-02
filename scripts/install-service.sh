#!/usr/bin/env bash
# Build the web UI and install rev as a systemd user service.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install
pnpm run build

mkdir -p ~/.config/systemd/user
cp systemd/rev.service ~/.config/systemd/user/rev.service
systemctl --user daemon-reload
systemctl --user enable --now rev.service
# survive logout
loginctl enable-linger "$USER" >/dev/null 2>&1 || true

sleep 1
systemctl --user --no-pager status rev.service || true
echo
echo "rev is up: http://$(hostname -I | awk '{print $1}'):${REV_PORT:-7373}"
