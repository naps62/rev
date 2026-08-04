#!/usr/bin/env bash
# Print packaging/homebrew/rev.rb rewritten for <version> <sha256>.
# Used by scripts/release.sh and by the release workflow.
set -euo pipefail

VERSION="${1#v}"
SHA="$2"
REPO="${REV_GH_REPO:-naps62/rev}"

sed -e "s|^  url .*|  url \"https://github.com/$REPO/releases/download/v$VERSION/rev-$VERSION.tar.gz\"|" \
    -e "s|^  sha256 .*|  sha256 \"$SHA\"|" \
    -e "s|^  version .*|  version \"$VERSION\"|" \
    "$(dirname "$0")/../packaging/homebrew/rev.rb"
