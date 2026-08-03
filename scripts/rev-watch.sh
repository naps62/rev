#!/usr/bin/env bash
# rev-watch.sh <dir> [cursor]
# Blocks until rev has comments for <dir> newer than the shared per-dir
# cursor, debounces a burst, prints the batch as JSON, advances the cursor.
# No timeout; server errors retry with backoff. Exit 0: delivered. 2: usage.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=rev-lib.sh
source "$SCRIPT_DIR/rev-lib.sh"

DIR="${1:?usage: rev-watch.sh <dir> [cursor]}"
CURSOR="${2:-}"
QUIET="${REV_WATCH_QUIET:-10}"
CAP="${REV_WATCH_CAP:-60}"

mkdir -p "$REV_STATE"
KEY=$(rev_key "$DIR")
CURSOR_FILE="$REV_STATE/$KEY.cursor"
LOCK_FILE="$REV_STATE/$KEY.lock"
PID_FILE="$REV_STATE/$KEY.pid"

printf '%s %s\n' "$$" "$DIR" >"$PID_FILE"
cleanup() {
  [[ "$(cut -d' ' -f1 "$PID_FILE" 2>/dev/null)" == "$$" ]] && rm -f "$PID_FILE" || true
}
trap cleanup EXIT

# Reparented to init = the arming session is gone; exiting would re-invoke
# nobody, and advancing the cursor would eat comments meant for the next one.
orphaned() { [[ "$(ps -o ppid= -p $$ | tr -d ' ')" == "1" ]]; }

fetch() { # fetch <since> <wait|""> <max-time-secs>
  local args=(-sfG --max-time "$3" --data-urlencode "dir=$DIR" --data-urlencode "since=$1")
  [[ -n "$2" ]] && args+=(--data-urlencode "wait=1")
  curl "${args[@]}" "$REV_HOST/api/comments"
}

# count = user comments only, so the watcher never wakes on the agent's own
# replies landing after the shared cursor.
jfield() { # jfield <count|cursor>  (JSON on stdin)
  python3 -c '
import json, sys
d = json.load(sys.stdin)
if sys.argv[1] == "count":
    print(sum(1 for c in d["comments"] if c["author"] == "user"))
else:
    print(d["cursor"])' "$1"
}

backoff=2
bump_backoff() { sleep "$backoff"; backoff=$(( backoff >= 60 ? 60 : backoff * 2 )); }

if [[ -z "$CURSOR" ]]; then
  exec 9>"$LOCK_FILE"
  flock 9
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
  flock -u 9
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

# Debounce: re-fetch from the ORIGINAL cursor (each response is the full
# batch so far) until QUIET secs pass with no new comment, capped at CAP
# secs total so a steady stream can't postpone delivery forever.
first=$SECONDS last_change=$SECONDS final="$resp" prev=$count
while (( SECONDS - last_change < QUIET && SECONDS - first < CAP )); do
  sleep 2
  r=$(fetch "$CURSOR" "" 5) || continue
  c=$(printf '%s' "$r" | jfield count) || continue
  (( c != prev )) && { prev=$c; last_change=$SECONDS; }
  final="$r"
done

orphaned && exit 0
exec 9>"$LOCK_FILE"
flock 9
printf '%s\n' "$(printf '%s' "$final" | jfield cursor)" >"$CURSOR_FILE"
flock -u 9

printf '%s\n' "$final"
printf 'rev: %s new review comment(s) on %s. Address each one, reply in-thread (POST %s/api/comments with author "agent" and parentId = the root comment id), then re-arm this watcher as a background task.\n' \
  "$prev" "$DIR" "$REV_HOST"
