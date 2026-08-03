#!/usr/bin/env bash
# Shared helpers for rev-watch.sh and the Claude Code hooks.
# Sourced, not executed.

REV_URL="${REV_URL:-http://localhost:7373}"
REV_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/rev"

# macOS ships neither sha256sum nor flock, and BSD stat takes different
# flags; everything below keeps the hooks working on both platforms.

if command -v sha256sum >/dev/null 2>&1; then
  rev_sha256() { sha256sum; }
else
  rev_sha256() { shasum -a 256; }
fi

# mtime as a unix timestamp. GNU stat vs BSD stat.
if stat -c %Y . >/dev/null 2>&1; then
  rev_mtime() { stat -c %Y "$1"; }
else
  rev_mtime() { stat -f %m "$1"; }
fi

# Stable short key for a worktree path; names all per-dir state files.
rev_key() { printf '%s' "$1" | rev_sha256 | cut -c1-16; }

# Advisory lock around $1, blocking up to $2 seconds (default 30); nonzero
# on timeout. A dead holder's lock is stolen via mv, not rm: two racing
# stealers would otherwise both win and delete each other's fresh lock.
rev_lock() {
  local d="$1.d" max="${2:-30}" waited=0 holder
  while ! mkdir "$d" 2>/dev/null; do
    holder=$(cat "$d/pid" 2>/dev/null || true)
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      mv "$d" "$d.stale.$$" 2>/dev/null && rm -rf "$d.stale.$$"
      continue
    fi
    (( waited++ >= max )) && return 1
    sleep 1
  done
  printf '%s' "$$" >"$d/pid"
}

rev_unlock() { rm -rf "$1.d"; }

# Worktree root for a cwd, empty + nonzero if not a git repo.
rev_root() { git -C "$1" rev-parse --show-toplevel 2>/dev/null; }

# Default-branch guess: origin/HEAD, falling back to main.
rev_base() {
  local ref
  ref=$(git -C "$1" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) &&
    { printf '%s' "${ref#origin/}"; return; }
  printf 'main'
}

# Is $1 a repo the rev server knows? Positive answers are cached in a marker
# file so the Stop hook never pays a server round-trip on the common path.
rev_known() {
  local dir="$1" marker="$REV_STATE/$(rev_key "$1").known"
  [[ -f "$marker" ]] && return 0
  mkdir -p "$REV_STATE"
  curl -sfG --max-time 2 "$REV_URL/api/diff/summary" \
    --data-urlencode "dir=$dir" --data-urlencode "base=$(rev_base "$dir")" \
    >"$marker.tmp" 2>/dev/null || { rm -f "$marker.tmp"; return 1; }
  mv "$marker.tmp" "$marker"
}

# Is a live rev-watch process holding $1?
rev_watcher_alive() {
  local pf="$REV_STATE/$(rev_key "$1").pid" pid
  [[ -f "$pf" ]] || return 1
  pid=$(cut -d' ' -f1 "$pf")
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null &&
    ps -o command= -p "$pid" 2>/dev/null | grep -q rev-watch
}
