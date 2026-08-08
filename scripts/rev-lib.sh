#!/usr/bin/env bash
# Shared helpers for rev-watch.sh and the Claude Code hooks.
# Sourced, not executed.

# REV_URL is the API the hooks call; REV_PUBLIC_URL is the base the user opens.
# Hooks don't inherit a login shell, so both fall back to the per-machine file
# the service reads — EnvironmentFile format, not shell, hence parsed.
_rev_env_file="${REV_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/rev/env}"
_rev_env_get() {
  [[ -f "$_rev_env_file" ]] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$_rev_env_file" |
    tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
REV_URL="${REV_URL:-$(_rev_env_get REV_URL)}"
REV_URL="${REV_URL:-http://localhost:7373}"
REV_PUBLIC_URL="${REV_PUBLIC_URL:-$(_rev_env_get REV_PUBLIC_URL)}"
REV_PUBLIC_URL="${REV_PUBLIC_URL:-$REV_URL}"

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

# Base-ref candidates for a worktree, best first, one per line. Empty and
# nonzero when the server is unreachable or the repo is unknown to it.
rev_refs() {
  curl -sfG --max-time 2 "$REV_URL/api/refs" --data-urlencode "dir=$1" 2>/dev/null |
    python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["refs"]))' 2>/dev/null
}

# Ref reviews should default to. The server picks among main/master/origin/*
# by newest merge-base with HEAD, so a stale local main can't drag its whole
# history into the review; guessing from origin/HEAD is the offline fallback.
rev_base() {
  local refs ref
  if refs=$(rev_refs "$1"); then
    ref=${refs%%$'\n'*}
    if [[ -n "$ref" ]]; then printf '%s' "$ref"; return; fi
  fi
  if ref=$(git -C "$1" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); then
    printf '%s' "$ref"
    return
  fi
  printf 'main'
}

# Is $1 a repo the rev server knows? Positive answers are cached in a marker
# file so the Stop hook never pays a server round-trip on the common path.
rev_known() {
  local dir="$1" marker="$REV_STATE/$(rev_key "$1").known"
  [[ -f "$marker" ]] && return 0
  mkdir -p "$REV_STATE"
  rev_refs "$dir" >"$marker.tmp" 2>/dev/null || { rm -f "$marker.tmp"; return 1; }
  mv "$marker.tmp" "$marker"
}

# PID of the session a hook runs under: nearest non-shell ancestor (hooks
# may sit behind `bash -c` wrappers). Nonzero when the walk hits init.
rev_owner_pid() {
  local pid=$PPID comm
  while [[ -n "$pid" ]] && (( pid > 1 )); do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ') || return 1
    comm=${comm##*/} comm=${comm#-}
    case "$comm" in
      bash|sh|zsh|dash|ksh) pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') ;;
      "") return 1 ;;
      *) printf '%s' "$pid"; return 0 ;;
    esac
  done
  return 1
}

# Is a live rev-watch process holding $1?
rev_watcher_alive() {
  local pf="$REV_STATE/$(rev_key "$1").pid" pid
  [[ -f "$pf" ]] || return 1
  pid=$(cut -d' ' -f1 "$pf")
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null &&
    ps -o command= -p "$pid" 2>/dev/null | grep -q rev-watch
}
