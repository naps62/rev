# rev

Always-on local code review server. One daemon, one port; every git repo and
worktree on the machine is reviewable at a URL, with live diffs (uncommitted
changes included), inline comment threads agents can answer over HTTP, per-file
seen-tracking that flags files changed after you reviewed them, and quick
in-place edits.

Design: `docs/ARCHITECTURE.md`.

## Install

Releases ship a prebuilt server and UI, so node is the only runtime
dependency — nothing is compiled on your machine.

### Homebrew (macOS and Linux)

```bash
brew install naps62/tap/rev
brew services start rev
rev install-hooks          # optional: wire rev into Claude Code
```

`brew upgrade rev` updates it. Homebrew owns the launchd/systemd unit and
pins its own node, so no toolchain hunting is involved.

### Without Homebrew

```bash
curl -fsSL https://raw.githubusercontent.com/naps62/rev/main/scripts/bootstrap.sh | bash
```

Downloads the latest release to `~/.rev`, installs an always-on user service
(systemd on Linux, launchd on macOS), and wires the Claude Code hooks into
`~/.claude/settings.json`. Idempotent — re-run the same line to update. Needs
Node >= 26, git, curl and python3; it finds a qualifying node on PATH, in
Homebrew (including keg-only `node@NN`), nvm, fnm, volta, mise or asdf, and
pins that exact binary in the service file.

To read it before running it, or to pass options:

```bash
curl -fsSL https://raw.githubusercontent.com/naps62/rev/main/scripts/bootstrap.sh -o rev-install.sh
less rev-install.sh && bash rev-install.sh --no-hooks
```

| Env | Default | |
|---|---|---|
| `REV_DIR` | `~/.rev` | Where to install |
| `REV_VERSION` | latest release | Version to install |
| `REV_GH_REPO` | `naps62/rev` | GitHub repo the releases live under (public mirror of the Gitea repo) |
| `REV_SOURCE` | `release` | `git` to clone and build from source instead |
| `REV_REPO` | `https://github.com/naps62/rev.git` | Clone URL, `REV_SOURCE=git` only; use the SSH form if you authenticate that way |
| `REV_REF` | `main` | Branch, `REV_SOURCE=git` only |

Already have a checkout? `./scripts/install-service.sh` is the same thing
without the download; it builds from source when there is no `rev.js` beside
it. `--no-hooks` skips the hook wiring.

The server listens on `127.0.0.1` and has no auth. To reach it from another
machine, put `REV_HOST=0.0.0.0` in `~/.config/rev/env` and restart the service —
anyone who can then reach the port can read diffs of every repo on the machine
and write files through it, so only do that on a network you trust. On macOS
that first start triggers the firewall's "accept incoming connections?" prompt.

To remove: `brew services stop rev && brew uninstall rev`, or for a bootstrap
install `launchctl bootout gui/$(id -u)/com.naps62.rev` (macOS) /
`systemctl --user disable --now rev.service` (Linux). Either way, drop the
hook entries from `~/.claude/settings.json` afterwards.

## Run

```bash
pnpm install

# dev (vite on :5173 proxying to the server on :7373)
pnpm dev

# production, no service
pnpm build && pnpm start
```

Open `http://localhost:7373`. A review is just a URL:

```
http://localhost:7373/review?dir=/abs/path/to/worktree&base=main
```

## Config

Set these in the environment, or — for the installed service — in
`~/.config/rev/env` as `KEY=value` lines. The service files are regenerated on
every install and deploy, so that file is the only place a per-machine setting
survives. A real environment variable still wins over it.

| Env | Default | |
|---|---|---|
| `REV_PORT` | `7373` | HTTP + WS port |
| `REV_HOST` | `127.0.0.1` | Bind address (server and vite dev server). `0.0.0.0` to reach it from other machines — see the warning above |
| `REV_URL` | `http://localhost:7373` | Base URL the hooks and `rev-watch.sh` talk to |
| `REV_PUBLIC_URL` | `$REV_URL` | Base URL the agent hands to you. Set it when rev is behind a custom domain or reverse proxy — the hooks keep calling `REV_URL` locally |
| `REV_ROOTS` | `~/tea` | Colon-separated roots scanned for repos; worktrees outside roots are found via `git worktree list`. The installed service sets `%h` (all of home) — scanning home skips `Desktop`, `Documents`, `Downloads`, `Pictures`, `Movies`, `Music`, `Videos`, `Library`, `Applications`, `Public`, so macOS never asks for those permissions. Name one in `REV_ROOTS` to scan it anyway; a review URL pointing inside one works either way. |
| `REV_DEPTH` | `4` | Max directory depth under each root when scanning (service sets 3) |
| `REV_DB` | `~/.local/share/rev/rev.db` | SQLite (comments, seen-state) |
| `REV_PERSONAL_HOSTS` | `git.naps.pt` | Comma-separated remote hosts whose repos land in the "personal" scope tab; any other remote is scoped by its owner org |
| `REV_PERSONAL_OWNERS` | `naps62` | Comma-separated remote owners treated as personal on any host |
| `REV_GH_BIN` | `gh` | GitHub CLI binary used to sync PR conversations (github.com remotes with an open PR for the reviewed branch). Missing binary just disables the feature |
| `REV_GITHUB_TO_AGENT` | off | `1` mirrors synced GitHub PR comments into the comment store for agent delivery, and forwards the agent's replies on those threads back to GitHub. Threads already resolved on GitHub are never mirrored. Sync runs when `/api/github` is polled (i.e. while a review page is open) |

All other knobs: `shared/tuning.ts`.

## Deploys

Merges to main on Gitea deploy automatically: a repo webhook (push, branch
`main`) hits the `rev-deploy` listener on `:7374`, which resets the prod
checkout (`~/tea/yolo/rev`) to `origin/main`, rebuilds, and restarts both
services. The webhook secret lives in `~/.config/rev/deploy.env`
(`REV_WEBHOOK_SECRET`); the listener rejects unsigned deliveries. Deploy runs
are detached transient units — `journalctl --user -u run-*` has their logs,
`journalctl --user -u rev-deploy` the listener's.

## Releases

`./scripts/release.sh 0.2.0` bumps the version, builds
`dist/rev-0.2.0.tar.gz` (bundled `rev.js` + built UI + hook scripts, ~400 KB),
tags, publishes the tarball on the GitHub mirror, and pushes the updated
formula to `naps62/homebrew-tap`. `--dry-run` builds and prints the formula
without touching any remote. Needs `gh` authenticated for both repos.

Pushing a `v*` tag runs `.github/workflows/release.yml`, which does the same
thing on CI; it needs a `TAP_TOKEN` secret with write access to the tap, and
skips the formula push without one. Use one path or the other, not both.

`packaging/homebrew/rev.rb` is the canonical formula — edit it here, never in
the tap. Both paths rewrite its url/sha256/version via
`scripts/bump-formula.sh`.

The tap repo needs one file, `Formula/rev.rb`; both paths create it.

## Agents

`./scripts/install-hooks.sh` wires rev into Claude Code globally (the
installer runs it unless you pass `--no-hooks`). Two hooks in
`~/.claude/settings.json`, referencing the checkout's `scripts/` (`~/.rev` by
default) so updates change behavior machine-wide:

- **SessionStart** — if the session's cwd is a repo rev knows
  (`/api/diff/summary` answers), injects `agent/CLAUDE-rev.md` with the review
  URL, current diff/comment counts, and the watcher arm command.
- **Stop** — at every turn boundary, if no live watcher holds the dir, blocks
  once with the arm command. Self-heals first-arm, re-arm after delivery, and
  watcher crashes.

User comments start **pending** — invisible to agents. The UI submits the
batch on explicit "Send now", after an idle window with no new comments, or
shortly after the page is hidden, so a review pass lands as one batch without
delivery lag on single comments. Delivery is `scripts/rev-watch.sh`, run by
the agent as a background task: it long-polls `/api/comments?submitted=1`,
prints the batch immediately, acks it (comments flip to "picked up" in the
UI), and exits — which re-invokes the session. A shared per-dir cursor in
`~/.local/state/rev/` makes delivery at-most-once across sessions. Non-Claude
agents can use the same API directly (`shared/types.ts`).

## Caveats (spike)

- No auth — anyone on the LAN can read diffs and write files. Do not expose
  beyond the LAN; a token check is the obvious next step.
- The REST/WS contract lives in `shared/types.ts`.
