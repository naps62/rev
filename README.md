# rev

Always-on local code review server. One daemon, one port; every git repo and
worktree on the machine is reviewable at a URL, with live diffs (uncommitted
changes included), inline comment threads agents can answer over HTTP, per-file
seen-tracking that flags files changed after you reviewed them, and quick
in-place edits.

Design: `docs/ARCHITECTURE.md`.

## Run

```bash
bun install

# dev (vite on :5173 proxying to the server on :7373)
bun run dev

# production
bun run build && bun run start

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

All other knobs: `shared/tuning.ts`.

## Agents

Append `agent/CLAUDE-rev.md` to a project's `CLAUDE.md` (or `~/.claude/CLAUDE.md`).
It tells the agent to hand you a review URL instead of starting a server, and
how to long-poll `/api/comments` and reply in-thread.

## Caveats (spike)

- No auth — anyone on the LAN can read diffs and write files. Do not expose
  beyond the LAN; a token check is the obvious next step.
- The REST/WS contract lives in `shared/types.ts`.
