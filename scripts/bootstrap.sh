#!/usr/bin/env bash
# One-liner installer. Clones (or updates) rev, then runs the real installer:
#
#   curl -fsSL <raw-url>/scripts/bootstrap.sh | bash
#
# Overridable: REV_DIR (checkout path), REV_REPO (clone URL), REV_REF (branch).
# Args are forwarded to install-service.sh, e.g. ... | bash -s -- --no-hooks
set -euo pipefail

REV_DIR="${REV_DIR:-$HOME/rev}"
REV_REPO="${REV_REPO:-https://github.com/naps62/rev.git}"
REV_REF="${REV_REF:-main}"

die() { printf 'rev-bootstrap: %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 ||
  die "git not found. macOS: xcode-select --install"

if [[ -d "$REV_DIR/.git" ]]; then
  echo "rev-bootstrap: updating $REV_DIR"
  git -C "$REV_DIR" fetch --quiet origin "$REV_REF" ||
    die "fetch failed. If $REV_REPO is private, check your git credentials."
  if [[ -n "$(git -C "$REV_DIR" status --porcelain)" ]]; then
    echo "rev-bootstrap: local changes present, leaving them alone (not fast-forwarding)"
  else
    git -C "$REV_DIR" checkout --quiet "$REV_REF"
    git -C "$REV_DIR" merge --quiet --ff-only "origin/$REV_REF"
  fi
else
  [[ -e "$REV_DIR" ]] && die "$REV_DIR exists but is not a git checkout. Move it, or set REV_DIR."
  echo "rev-bootstrap: cloning into $REV_DIR"
  git clone --quiet --branch "$REV_REF" "$REV_REPO" "$REV_DIR" ||
    die "clone failed. If $REV_REPO is private, set up git credentials for it first (or set REV_REPO to an SSH URL)."
fi

# stdin is the piped script itself; keep the installer from inheriting it.
exec "$REV_DIR/scripts/install-service.sh" "$@" </dev/null
