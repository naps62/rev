#!/usr/bin/env bash
# One-liner installer for machines without Homebrew (with it, prefer
# `brew install naps62/tap/rev`):
#
#   curl -fsSL <raw-url>/scripts/bootstrap.sh | bash
#
# Downloads the latest release into REV_DIR, then runs the real installer.
# Releases ship a prebuilt server and UI, so node is the only dependency.
#
# Overridable: REV_DIR (install path), REV_VERSION (default: latest release),
# REV_GH_REPO (owner/name the releases live under), REV_SOURCE=git to build
# from a clone instead (then REV_REPO and REV_REF apply).
# Args are forwarded to install-service.sh, e.g. ... | bash -s -- --no-hooks
set -euo pipefail

REV_DIR="${REV_DIR:-$HOME/.rev}"
REV_SOURCE="${REV_SOURCE:-release}"
REV_GH_REPO="${REV_GH_REPO:-naps62/rev}"
REV_REPO="${REV_REPO:-https://github.com/naps62/rev.git}"
REV_REF="${REV_REF:-main}"

die() { printf 'rev-bootstrap: %s\n' "$1" >&2; exit 1; }

install_git() {
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
}

install_release() {
  command -v curl >/dev/null 2>&1 || die "curl not found."
  [[ -d "$REV_DIR/.git" ]] &&
    die "$REV_DIR is a checkout from an older install. Keep it with REV_SOURCE=git, or move it aside."

  local version="${REV_VERSION:-}"
  if [[ -z "$version" ]]; then
    version=$(curl -fsSL "https://api.github.com/repos/$REV_GH_REPO/releases/latest" |
      sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) ||
      die "could not reach the GitHub API. Set REV_VERSION to pick a release, or REV_SOURCE=git."
    [[ -n "$version" ]] || die "no published release found. Set REV_VERSION, or use REV_SOURCE=git."
  fi
  version="${version#v}"

  local url="https://github.com/$REV_GH_REPO/releases/download/v$version/rev-$version.tar.gz"
  # Staged beside REV_DIR so the swap is a rename, not a cross-device copy.
  local tmp; tmp=$(mktemp -d "$(dirname "$REV_DIR")/.rev-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT

  echo "rev-bootstrap: fetching rev $version"
  curl -fsSL "$url" -o "$tmp/rev.tar.gz" || die "download failed: $url"
  tar -xzf "$tmp/rev.tar.gz" -C "$tmp"
  [[ -x "$tmp/rev-$version/bin/rev" ]] || die "unexpected tarball layout in $url"

  rm -rf "$REV_DIR.old"
  [[ -e "$REV_DIR" ]] && mv "$REV_DIR" "$REV_DIR.old"
  mv "$tmp/rev-$version" "$REV_DIR"
  rm -rf "$REV_DIR.old"
  echo "rev-bootstrap: installed rev $version to $REV_DIR"
}

case "$REV_SOURCE" in
  release) install_release ;;
  git)     install_git ;;
  *)       die "REV_SOURCE must be 'release' or 'git' (got '$REV_SOURCE')" ;;
esac

# stdin is the piped script itself; keep the installer from inheriting it.
exec "$REV_DIR/scripts/install-service.sh" "$@" </dev/null
