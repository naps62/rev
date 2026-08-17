#!/usr/bin/env bash
# Build and (re)start rev from the current checkout. Invoked by the
# rev-deploy webhook listener after it has reset the checkout to origin/main;
# also usable by hand for a first install.
set -euo pipefail
cd "$(dirname "$0")/.."
CHECKOUT=$PWD

. "$CHECKOUT/scripts/service-lib.sh"
rev_resolve_node

pnpm install --frozen-lockfile
pnpm build

# Set REV_SKIP_UNIT_INSTALL=1 when something else owns the unit files (a nix
# home-manager generation, ansible, ...). Writing them here would replace files
# that config manager considers its own, and its next run then refuses to
# reconcile. Unset — the default — installs them as before.
if [ "${REV_SKIP_UNIT_INSTALL:-0}" = 1 ]; then
  echo "deploy: REV_SKIP_UNIT_INSTALL=1, leaving unit files to the config manager"
else
  mkdir -p ~/.config/systemd/user
  rev_render "$CHECKOUT/systemd/rev.service.template" ~/.config/systemd/user/rev.service 0
  cp systemd/rev-deploy.service ~/.config/systemd/user/
  systemctl --user daemon-reload

  systemctl --user enable rev.service rev-deploy.service >/dev/null
fi

systemctl --user restart rev.service

# The deploy job runs detached (systemd-run), so it is safe to replace the
# listener that spawned it. Free the port first: a bootstrap listener may be
# running outside the service unit.
systemctl --user stop rev-deploy.service 2>/dev/null || true
fuser -k -TERM "${REV_DEPLOY_PORT:-7374}/tcp" 2>/dev/null || true
sleep 0.5
systemctl --user start rev-deploy.service

echo "deployed $(git rev-parse --short HEAD)"
