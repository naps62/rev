#!/usr/bin/env bash
# Claude Code Stop hook. In rev-known repos, blocks the stop once with an
# arm command whenever no live watcher holds the dir. Silent otherwise.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=rev-lib.sh
source "$SCRIPT_DIR/rev-lib.sh"

input=$(cat)
read -r cwd active < <(printf '%s' "$input" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("cwd", "") or "-", str(d.get("stop_hook_active", False)).lower())' 2>/dev/null) || exit 0

[[ "$active" == "true" ]] && exit 0
[[ "$cwd" != "-" ]] || exit 0
root=$(rev_root "$cwd") || exit 0
rev_known "$root" || exit 0

flag="$REV_STATE/$(rev_key "$root").blocked"
if rev_watcher_alive "$root"; then
  rm -f "$flag"
  exit 0
fi

# Don't nag every turn if arming keeps failing; retry after 10 minutes.
if [[ -f "$flag" ]] && (( $(date +%s) - $(stat -c %Y "$flag") < 600 )); then
  exit 0
fi
touch "$flag"

ROOT="$root" WATCH="$SCRIPT_DIR/rev-watch.sh" python3 <<'PY'
import json, os
root, watch = os.environ["ROOT"], os.environ["WATCH"]
print(json.dumps({"decision": "block", "reason":
    f"The rev comment watcher is not armed for {root}. Arm it now via the "
    f"Bash tool with run_in_background: true: `{watch} {root}` — it delivers "
    "the user's review comments when they arrive; address them, reply "
    "in-thread, and re-arm it. Then continue (or finish) your turn."}))
PY
