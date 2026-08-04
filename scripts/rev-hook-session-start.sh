#!/usr/bin/env bash
# Claude Code SessionStart hook. If the session's cwd is a repo rev knows,
# injects review instructions (URL, watcher arm command, reply etiquette)
# as additionalContext. Silent no-op otherwise. Never fails the session.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=rev-lib.sh
source "$SCRIPT_DIR/rev-lib.sh"

input=$(cat)
cwd=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd",""))' 2>/dev/null) || exit 0
[[ -n "$cwd" ]] || exit 0
root=$(rev_root "$cwd") || exit 0
base=$(rev_base "$root")

summary=$(curl -sfG --max-time 2 "$REV_URL/api/diff/summary" \
  --data-urlencode "dir=$root" --data-urlencode "base=$base" 2>/dev/null) || exit 0
mkdir -p "$REV_STATE"
printf '%s' "$summary" >"$REV_STATE/$(rev_key "$root").known"

# submitted=1: pending comments are unsent drafts — not the agent's business
comments=$(curl -sfG --max-time 2 "$REV_URL/api/comments" \
  --data-urlencode "dir=$root" --data-urlencode "submitted=1" 2>/dev/null) || comments='{"comments":[]}'

SUMMARY="$summary" COMMENTS="$comments" ROOT="$root" BASE="$base" \
HOST="$REV_URL" PUBLIC="$REV_PUBLIC_URL" WATCH="$SCRIPT_DIR/rev-watch.sh" \
TEMPLATE="$SCRIPT_DIR/../agent/CLAUDE-rev.md" \
python3 <<'PY'
import json, os, urllib.parse

env = os.environ
summary = json.loads(env["SUMMARY"])
comments = json.loads(env["COMMENTS"])
root, base, host = env["ROOT"], env["BASE"], env["HOST"]
public = env.get("PUBLIC") or host

nfiles = len(summary.get("files", []))
nthreads = sum(1 for c in comments.get("comments", [])
               if not c.get("parentId") and not c.get("resolvedAt"))

if nfiles or nthreads:
    parts = []
    if nfiles:
        parts.append(f"{nfiles} changed file(s) against {base}")
    if nthreads:
        parts.append(f"{nthreads} open comment thread(s) — the user may "
                     "already be reviewing; check them before large edits")
    status = "Current state: " + "; ".join(parts) + "."
else:
    status = f"No diff against {base} yet."

url = (f"{public.rstrip('/')}/review?dir={urllib.parse.quote(root, safe='')}"
       f"&base={urllib.parse.quote(base, safe='')}")
text = open(env["TEMPLATE"]).read()
for k, v in {"DIR": root, "URL": url, "HOST": host, "BASE": base,
             "WATCH": env["WATCH"], "STATUS": status}.items():
    text = text.replace("{{%s}}" % k, v)

print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": text,
}}))
PY
