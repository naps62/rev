#!/usr/bin/env bash
# Shared by install-service.sh and deploy.sh: picks the node the service will
# run under, and renders the systemd/launchd templates. Sourced, not executed.
# Expects $CHECKOUT; defines $NODE, prepends its bin dir to PATH.

if ! declare -F die >/dev/null; then
  die() { printf 'rev: %s\n' "$1" >&2; exit 1; }
fi

# package.json declares node >=26; the server runs .ts directly and uses
# node:sqlite, neither of which works on older majors.
NODE_MIN=26

# Not just `command -v node`: the winner here is written into the service file
# and the daemon runs it forever, so an unrelated toolchain fronting PATH would
# stick. Highest qualifying major wins.
rev_node_candidates() {
  command -v node 2>/dev/null || true
  local brew_opt
  for brew_opt in /opt/homebrew/opt /usr/local/opt; do
    # keg-only formulae: brew install node@26 does not put node on PATH
    ls -d "$brew_opt"/node@*/bin/node 2>/dev/null || true
  done
  ls -d /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node 2>/dev/null || true
  ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node 2>/dev/null || true
  ls -d "${XDG_DATA_HOME:-$HOME/.local/share}"/fnm/node-versions/*/installation/bin/node 2>/dev/null || true
  ls -d "$HOME"/.volta/tools/image/node/*/bin/node 2>/dev/null || true
  ls -d "${XDG_DATA_HOME:-$HOME/.local/share}"/mise/installs/node/*/bin/node 2>/dev/null || true
  ls -d "$HOME"/.asdf/installs/nodejs/*/bin/node 2>/dev/null || true
}

rev_resolve_node() {
  local cand major found=0 best_major=0
  NODE=""
  while read -r cand; do
    [[ -n "$cand" && -x "$cand" ]] || continue
    major=$("$cand" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || continue
    [[ "$major" =~ ^[0-9]+$ ]] || continue
    found=1
    (( major >= NODE_MIN && major > best_major )) || continue
    NODE=$cand
    best_major=$major
  done < <(rev_node_candidates)

  if [[ -z "$NODE" ]]; then
    local hint="Install Node >= $NODE_MIN: 'brew install node@$NODE_MIN', 'nvm install $NODE_MIN', or https://nodejs.org"
    if (( found )); then
      die "no node >= $NODE_MIN found (searched PATH, Homebrew, nvm, fnm, volta, mise, asdf). $hint"
    fi
    die "node not found. $hint"
  fi

  # pnpm, its subprocesses and the service file must all agree on this node,
  # not on whatever PATH happened to front.
  export PATH="$(dirname "$NODE"):$PATH"
  echo "rev: using node $("$NODE" -p process.versions.node) ($NODE)"
}

# rev_render <template> <out> <xml-escape 0|1> — substitutes @NODE@,
# @CHECKOUT@, @HOME@, @PATH@. launchd and systemd hand a user unit a bare PATH
# that omits Homebrew and nvm, and the server shells out to git.
rev_render() {
  NODE="$NODE" CHECKOUT="$CHECKOUT" HOME="$HOME" \
  TEMPLATE="$1" OUT="$2" XML="$3" \
  python3 <<'PY'
import os
from xml.sax.saxutils import escape

env = os.environ
node = env["NODE"]
dirs = [os.path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin",
        "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
subs = {"@NODE@": node, "@CHECKOUT@": env["CHECKOUT"], "@HOME@": env["HOME"],
        "@PATH@": ":".join(dict.fromkeys(dirs))}

with open(env["TEMPLATE"]) as f:
    text = f.read()
for k, v in subs.items():
    text = text.replace(k, escape(v) if env["XML"] == "1" else v)
with open(env["OUT"], "w") as f:
    f.write(text)
print(f"wrote {env['OUT']}")
PY
}

# pnpm is not guaranteed to exist, and corepack no longer ships with node.
rev_ensure_pnpm() {
  command -v pnpm >/dev/null 2>&1 && return
  corepack enable >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 ||
    die "pnpm not found and could not be installed. Install it: 'brew install pnpm' or 'npm i -g pnpm'"
  command -v pnpm >/dev/null 2>&1 || die "pnpm still not on PATH after installing it."
  echo "rev: installed pnpm"
}
