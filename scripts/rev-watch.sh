#!/usr/bin/env bash
# rev-watch.sh <dir> [cursor]
# Blocks until rev has SUBMITTED comments for <dir> newer than the shared
# per-dir cursor (the UI batches at submit time), prints the batch as JSON,
# advances the cursor, acks the delivery. No timeout; server errors retry
# with backoff. Exit 0: delivered. 2: usage.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=rev-lib.sh
source "$SCRIPT_DIR/rev-lib.sh"

DIR="${1:?usage: rev-watch.sh <dir> [cursor]}"
CURSOR="${2:-}"
QUIET="${REV_WATCH_QUIET:-0}"
CAP="${REV_WATCH_CAP:-60}"

mkdir -p "$REV_STATE"
KEY=$(rev_key "$DIR")
CURSOR_FILE="$REV_STATE/$KEY.cursor"
LOCK_FILE="$REV_STATE/$KEY.lock"
PID_FILE="$REV_STATE/$KEY.pid"

printf '%s %s\n' "$$" "$DIR" >"$PID_FILE"
HELD_LOCK=""
cleanup() {
  [[ -n "$HELD_LOCK" ]] && rev_unlock "$HELD_LOCK" || true
  [[ "$(cut -d' ' -f1 "$PID_FILE" 2>/dev/null)" == "$$" ]] && rm -f "$PID_FILE" || true
}
release_lock() { [[ -n "$HELD_LOCK" ]] && { rev_unlock "$HELD_LOCK"; HELD_LOCK=""; } || true; }
trap cleanup EXIT

# Reparented to init = the arming session is gone; exiting would re-invoke
# nobody, and advancing the cursor would eat comments meant for the next one.
orphaned() { [[ "$(ps -o ppid= -p $$ | tr -d ' ')" == "1" ]]; }

fetch() { # fetch <since> <wait|""> <max-time-secs>
  local args=(-sfG --max-time "$3" --data-urlencode "dir=$DIR" --data-urlencode "since=$1")
  args+=(--data-urlencode "submitted=1")
  [[ -n "$2" ]] && args+=(--data-urlencode "wait=1")
  curl "${args[@]}" "$REV_HOST/api/comments"
}

# count excludes author=agent (this session's own replies land after the
# shared cursor); any other author — user, future reviewer roles — wakes us.
jfield() { # jfield <count|cursor>  (JSON on stdin)
  python3 -c '
import json, sys
d = json.load(sys.stdin)
if sys.argv[1] == "count":
    print(sum(1 for c in d["comments"] if c["author"] != "agent"))
else:
    print(d["cursor"])' "$1"
}

backoff=2
bump_backoff() { sleep "$backoff"; backoff=$(( backoff >= 60 ? 60 : backoff * 2 )); }

if [[ -z "$CURSOR" ]]; then
  rev_lock "$LOCK_FILE" && HELD_LOCK="$LOCK_FILE" || true
  if [[ -s "$CURSOR_FILE" ]]; then
    CURSOR=$(<"$CURSOR_FILE")
  else
    while :; do
      orphaned && exit 0
      resp=$(fetch 0 "" 5) && break
      bump_backoff
    done
    CURSOR=$(printf '%s' "$resp" | jfield cursor)
    printf '%s\n' "$CURSOR" >"$CURSOR_FILE"
  fi
  release_lock
fi

backoff=2
while :; do
  orphaned && exit 0
  resp=$(fetch "$CURSOR" 1 40) || { bump_backoff; continue; }
  backoff=2
  count=$(printf '%s' "$resp" | jfield count) || continue
  if (( count == 0 )); then
    # Follow the server's cursor on idle rounds; also self-heals a reset db.
    CURSOR=$(printf '%s' "$resp" | jfield cursor)
    continue
  fi
  break
done

# Optional coalescing (QUIET=0 skips it — the UI already batched at submit
# time): re-fetch from the ORIGINAL cursor (each response is the full batch
# so far) until QUIET secs pass with no new comment, capped at CAP secs.
first=$SECONDS last_change=$SECONDS final="$resp" prev=$count
while (( SECONDS - last_change < QUIET && SECONDS - first < CAP )); do
  sleep 2
  r=$(fetch "$CURSOR" "" 5) || continue
  c=$(printf '%s' "$r" | jfield count) || continue
  (( c != prev )) && { prev=$c; last_change=$SECONDS; }
  final="$r"
done

orphaned && exit 0
NEW_CURSOR=$(printf '%s' "$final" | jfield cursor)
rev_lock "$LOCK_FILE" && HELD_LOCK="$LOCK_FILE" || true
printf '%s\n' "$NEW_CURSOR" >"$CURSOR_FILE"
release_lock

# Best-effort delivery ack: flips the batch to "picked up" in the UI.
ack=$(python3 -c 'import json,sys; print(json.dumps({"dir": sys.argv[1], "upTo": int(sys.argv[2])}))' "$DIR" "$NEW_CURSOR") &&
  curl -sf --max-time 5 -X POST "$REV_HOST/api/comments/ack" \
    -H 'content-type: application/json' -d "$ack" >/dev/null || true

printf '%s\n' "$final"
printf 'rev: %s new review comment(s) on %s. Address each one, reply in-thread (POST %s/api/comments with author "agent" and parentId = the root comment id), then re-arm this watcher as a background task.\n' \
  "$prev" "$DIR" "$REV_HOST"
