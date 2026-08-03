# rev

Always-on local code review server. One daemon, one port; every git repo and
worktree on the machine is reviewable at a URL, with live diffs (uncommitted
changes included), inline comment threads agents can answer over HTTP, per-file
seen-tracking that flags files changed after you reviewed them, and quick
in-place edits.

Design: `docs/ARCHITECTURE.md`.

## Install

Needs Node >= 26, git and python3. The installer finds a qualifying node on
PATH, in Homebrew (including keg-only `node@NN`), nvm, fnm, volta, mise or
asdf, and pins that exact binary in the service file — so a `brew install
node@26` is enough even when another toolchain owns `node` on your PATH. pnpm
is installed if missing.

```bash
curl -fsSL https://raw.githubusercontent.com/naps62/rev/main/scripts/bootstrap.sh | bash
```

Clones to `~/.rev`, builds the UI, installs an always-on user service (systemd
on Linux, launchd on macOS), and wires the Claude Code hooks into
`~/.claude/settings.json`. Idempotent — re-run the same line to update.

To read it before running it, or to pass options:

```bash
curl -fsSL https://raw.githubusercontent.com/naps62/rev/main/scripts/bootstrap.sh -o rev-install.sh
less rev-install.sh && bash rev-install.sh --no-hooks
```

| Env | Default | |
|---|---|---|
| `REV_DIR` | `~/.rev` | Where to clone |
| `REV_REPO` | `https://github.com/naps62/rev.git` | Clone URL (public mirror of the Gitea repo); use the SSH form if you authenticate that way |
| `REV_REF` | `main` | Branch |

Already cloned? `./scripts/install-service.sh` is the same thing without the
clone step. `--no-hooks` skips the hook wiring.

The server listens on `0.0.0.0` with no auth: anyone who can reach the port
can read diffs of every repo on the machine and write files through it. Only
run it on a network you trust. On macOS the first start triggers the
firewall's "accept incoming connections?" prompt — allowing it exposes the
port to the LAN, denying it keeps rev to localhost.

To remove: `launchctl bootout gui/$(id -u)/com.naps62.rev` (macOS) or
`systemctl --user disable --now rev.service` (Linux), then drop the hook
entries from `~/.claude/settings.json`.

## Run

```bash
pnpm install

# dev (vite on :5173 proxying to the server on :7373)
pnpm dev

# production, no service
pnpm build && pnpm start
```

Open `http://<machine-ip>:7373`. A review is just a URL:

```
http://<machine-ip>:7373/review?dir=/abs/path/to/worktree&base=main
```

## Config

| Env | Default | |
|---|---|---|
| `REV_PORT` | `7373` | HTTP + WS port |
| `REV_ROOTS` | `~/tea` | Colon-separated roots scanned for repos; worktrees outside roots are found via `git worktree list`. The installed service sets `%h` (all of home). |
| `REV_DEPTH` | `4` | Max directory depth under each root when scanning (service sets 3) |
| `REV_DB` | `~/.local/share/rev/rev.db` | SQLite (comments, seen-state) |
| `REV_PERSONAL_HOSTS` | `git.naps.pt` | Comma-separated remote hosts whose repos land in the "personal" scope tab; any other remote is scoped by its owner org |
| `REV_PERSONAL_OWNERS` | `naps62` | Comma-separated remote owners treated as personal on any host |

All other knobs: `shared/tuning.ts`.

## Deploys

Merges to main on Gitea deploy automatically: a repo webhook (push, branch
`main`) hits the `rev-deploy` listener on `:7374`, which resets the prod
checkout (`~/tea/yolo/rev`) to `origin/main`, rebuilds, and restarts both
services. The webhook secret lives in `~/.config/rev/deploy.env`
(`REV_WEBHOOK_SECRET`); the listener rejects unsigned deliveries. Deploy runs
are detached transient units — `journalctl --user -u run-*` has their logs,
`journalctl --user -u rev-deploy` the listener's.

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
