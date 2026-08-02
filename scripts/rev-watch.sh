#!/usr/bin/env bash
# rev-watch.sh <dir> [cursor] [timeout-seconds]
# Blocks until rev has review comments newer than cursor, prints them as JSON.
# Exit 0: comments printed. 2: usage/server error. 3: timeout, none arrived.
set -euo pipefail

DIR="${1:?usage: rev-watch.sh <dir> [cursor] [timeout-seconds]}"
CURSOR="${2:-}"
TIMEOUT="${3:-3600}"
HOST="${REV_HOST:-http://localhost:7373}"

if [[ -z "$CURSOR" ]]; then
  CURSOR=$(curl -sf "$HOST/api/comments?dir=$DIR" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cursor"])') || {
    echo "rev-watch: cannot reach $HOST or unknown dir: $DIR" >&2
    exit 2
  }
fi

deadline=$((SECONDS + TIMEOUT))
while ((SECONDS < deadline)); do
  resp=$(curl -sf --max-time 40 "$HOST/api/comments?dir=$DIR&since=$CURSOR&wait=1" || true)
  [[ -z "$resp" ]] && { sleep 2; continue; }
  count=$(printf '%s' "$resp" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["comments"]))' 2>/dev/null || echo 0)
  if [[ "$count" != "0" ]]; then
    printf '%s\n' "$resp"
    exit 0
  fi
  CURSOR=$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cursor"])' 2>/dev/null || echo "$CURSOR")
done
echo "rev-watch: no comments within ${TIMEOUT}s" >&2
exit 3
