#!/usr/bin/env bash
# Wires the rev SessionStart/Stop hooks into ~/.claude/settings.json,
# referencing the prod checkout so deploys update behavior machine-wide.
# Idempotent. Override the checkout with REV_CHECKOUT.
set -euo pipefail

CHECKOUT="${REV_CHECKOUT:-$(cd "$(dirname "$0")/.." && pwd)}"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

for s in rev-hook-session-start.sh rev-hook-stop.sh rev-watch.sh rev-lib.sh; do
  [[ -e "$CHECKOUT/scripts/$s" ]] || {
    echo "install-hooks: $CHECKOUT/scripts/$s not found (merge/deploy first, or set REV_CHECKOUT)" >&2
    exit 1
  }
done

SETTINGS="$SETTINGS" CHECKOUT="$CHECKOUT" python3 <<'PY'
import json, os

path = os.environ["SETTINGS"]
scripts = os.path.join(os.environ["CHECKOUT"], "scripts")
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        cfg = json.load(f)

hooks = cfg.setdefault("hooks", {})
changed = False
for event, script in [("SessionStart", "rev-hook-session-start.sh"),
                      ("Stop", "rev-hook-stop.sh")]:
    cmd = os.path.join(scripts, script)
    matchers = hooks.setdefault(event, [])
    if any(h.get("command") == cmd
           for m in matchers for h in m.get("hooks", [])):
        print(f"{event}: already installed")
        continue
    matchers.append({"hooks": [{"type": "command", "command": cmd}]})
    print(f"{event}: added {cmd}")
    changed = True

if changed:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    print(f"wrote {path}")
PY
