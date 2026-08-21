#!/usr/bin/env bash
# Cut a release from a clean main: bump the version, build the tarball as a
# smoke test, commit, tag, and push. The release workflow on the GitHub
# mirror publishes the asset and bumps the tap — the local tarball is never
# published (builds are not reproducible, its sha would not match CI's).
#
#   ./scripts/release.sh 0.2.0
#
# Pass --dry-run to build and print the formula without pushing anything.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
VERSION="${VERSION#v}"
DRY=0
[[ "${2:-}" == "--dry-run" ]] && DRY=1

REPO="${REV_GH_REPO:-naps62/rev}"
TAP="${REV_TAP_REPO:-naps62/homebrew-tap}"

die() { printf 'release: %s\n' "$1" >&2; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: release.sh <major.minor.patch> [--dry-run]"

if (( ! DRY )); then
  [[ -z "$(git status --porcelain)" ]] || die "working tree is dirty"
  [[ "$(git rev-parse --abbrev-ref HEAD)" == main ]] || die "not on main"
  git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && die "tag v$VERSION already exists"
fi

# A dry run still has to bump both files (package.sh names the tarball from
# package.json), so snapshot them and put them back on any exit.
if (( DRY )); then
  BAK=$(mktemp -d)
  cp package.json packaging/homebrew/rev.rb "$BAK/"
  trap 'cp "$BAK/package.json" package.json; cp "$BAK/rev.rb" packaging/homebrew/rev.rb; rm -rf "$BAK"' EXIT
fi

node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = process.argv[1];
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$VERSION"

./scripts/package.sh
TARBALL="dist/rev-$VERSION.tar.gz"
SHA=$(cut -d' ' -f1 < "$TARBALL.sha256")

./scripts/bump-formula.sh "$VERSION" "$SHA" > packaging/homebrew/rev.rb.new
mv packaging/homebrew/rev.rb.new packaging/homebrew/rev.rb

if (( DRY )); then
  echo "--- would publish $TARBALL ($SHA) to $REPO, formula to $TAP"
  sed -n '/^class/,/^  end$/p' packaging/homebrew/rev.rb | head -12
  exit 0
fi

git commit -q -am "chore: release v$VERSION"
git tag "v$VERSION"
git push -q origin main "v$VERSION"

# The GitHub repo is a mirror of Gitea; give it a moment to pick the tag up,
# and push directly if a remote for it exists.
git remote get-url github >/dev/null 2>&1 && git push -q github main "v$VERSION"

# Publishing is the release workflow's job: tarballs are not reproducible,
# so a second publisher desyncs the formula sha from the release asset.
echo "tagged v$VERSION — release workflow on $REPO publishes the asset and bumps $TAP"
