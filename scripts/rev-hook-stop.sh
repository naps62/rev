#!/usr/bin/env bash
# Claude Code Stop hook. While the user has a repo's review page open, blocks
# the stop once with an arm command whenever no live watcher holds the dir.
# Silent otherwise.
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
rev_known_cached "$root" || exit 0
# Nag only while the user actually has this review open: an unarmed watcher
# matters then, and every other time the block is just noise in the session.
rev_reviewing "$root" || exit 0

flag="$REV_STATE/$(rev_key "$root").blocked"
if rev_watcher_alive "$root"; then
  rm -f "$flag"
  exit 0
fi

# Don't nag every turn if arming keeps failing; retry after 10 minutes.
if [[ -f "$flag" ]] && (( $(date +%s) - $(rev_mtime "$flag") < 600 )); then
  exit 0
fi
touch "$flag"

OWNER=$(rev_owner_pid) || OWNER=""

ROOT="$root" WATCH="$SCRIPT_DIR/rev-watch.sh" OWNER="$OWNER" python3 <<'PY'
import json, os
root, watch = os.environ["ROOT"], os.environ["WATCH"]
owner = os.environ.get("OWNER", "")
arm = f"{watch} {root}" + (f" --owner-pid {owner}" if owner else "")
print(json.dumps({"decision": "block", "reason":
    f"Arm the rev comment watcher via the Bash tool with "
    f"run_in_background: true: `{arm}` — then end your turn. "
    "Do it silently: no mention of the watcher in your reply."}))
PY
