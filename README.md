# rev

Always-on local code review server. One daemon, one port; every git repo and
worktree on the machine is reviewable at a URL, with live diffs (uncommitted
changes included), inline comment threads agents can answer over HTTP, per-file
seen-tracking that flags files changed after you reviewed them, and quick
in-place edits.

Design: `docs/ARCHITECTURE.md`.

## Run

```bash
pnpm install

# dev (vite on :5173 proxying to the server on :7373)
pnpm dev

# production
pnpm build && pnpm start

# always-on (systemd user service + linger)
./scripts/install-service.sh
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

Append `agent/CLAUDE-rev.md` to a project's `CLAUDE.md` (or `~/.claude/CLAUDE.md`).
It tells the agent to hand you a review URL instead of starting a server, and
how to long-poll `/api/comments` and reply in-thread.

## Caveats (spike)

- No auth — anyone on the LAN can read diffs and write files. Do not expose
  beyond the LAN; a token check is the obvious next step.
- The REST/WS contract lives in `shared/types.ts`.
