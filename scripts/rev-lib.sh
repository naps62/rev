#!/usr/bin/env bash
# Shared helpers for rev-watch.sh and the Claude Code hooks.
# Sourced, not executed.

REV_HOST="${REV_HOST:-http://localhost:7373}"
REV_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/rev"

# Stable short key for a worktree path; names all per-dir state files.
rev_key() { printf '%s' "$1" | sha256sum | cut -c1-16; }

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
  curl -sfG --max-time 2 "$REV_HOST/api/diff/summary" \
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
    grep -q rev-watch "/proc/$pid/cmdline" 2>/dev/null
}
