#!/usr/bin/env bash
# Build dist/rev-<version>.tar.gz (+ .sha256 for the Homebrew formula): one
# bundled rev.js, the built UI, and the shell bits the hooks need. Node is the
# only runtime dependency — no node_modules, pnpm or vite on the target.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p 'require("./package.json").version')
NAME="rev-$VERSION"
OUT="$PWD/dist"
STAGE="$OUT/$NAME"

rm -rf "$STAGE" "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256"
mkdir -p "$STAGE"

pnpm run --silent build
pnpm run --silent bundle

mkdir -p "$STAGE/web"
cp dist/rev.js "$STAGE/rev.js"
cp -R web/dist "$STAGE/web/dist"
cp -R agent "$STAGE/agent"
cp -R bin "$STAGE/bin"
cp README.md "$STAGE/README.md"
echo "$VERSION" > "$STAGE/VERSION"

# Only the scripts a release install runs: the hooks, their helpers, and the
# service installer. Nothing that rebuilds from source.
mkdir -p "$STAGE/scripts" "$STAGE/systemd" "$STAGE/launchd"
cp scripts/install-hooks.sh scripts/install-service.sh scripts/service-lib.sh \
   scripts/rev-hook-session-start.sh scripts/rev-hook-stop.sh \
   scripts/rev-lib.sh scripts/rev-watch.sh "$STAGE/scripts/"
cp systemd/rev.service.template "$STAGE/systemd/"
cp launchd/com.naps62.rev.plist.template "$STAGE/launchd/"
chmod +x "$STAGE/bin/rev" "$STAGE"/scripts/*.sh

tar -C "$OUT" --format=ustar --numeric-owner --owner=0 --group=0 \
    -czf "$OUT/$NAME.tar.gz" "$NAME"
rm -rf "$STAGE"

( cd "$OUT" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
cat "$OUT/$NAME.tar.gz.sha256"
