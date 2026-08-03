# rev — architecture

An always-running local review server. One instance per machine, one port. It
watches every git repo and worktree under configured roots and serves a web UI
showing the live diff of any of them against any base ref — including
uncommitted and untracked changes. Agents link the user to
`http://<host>:7373/review?dir=<abs-path>&base=<ref>` and interact with
comments over the same HTTP API.

## Why a daemon

One server per review session means port conflicts, stale merge-bases,
restarts when new commits land, and manual "I wrote a comment" pings to the
agent. rev fixes each structurally:

- **One daemon, one port** (default 7373, `REV_PORT`). Reviews are URLs, not
  processes.
- **Merge-base computed per request** — the diff is never stale.
- **Filesystem watcher per repo** — edits show up in the UI within ~200ms,
  committed or not. Files the user marked seen get flagged stale instead of
  silently changing.
- **Comments live in the server's SQLite DB** with a poll/watch API, so agents
  can wait on them instead of the user relaying.

## Layout

```
shared/types.ts    — the API contract (single source of truth, imported by both sides)
shared/tuning.ts   — every magic number, with reasoning
server/            — Node + Hono: git ops, discovery, watcher, comments DB, WS, REST
web/               — Vite + React 19 + Tailwind v4 diff UI
agent/CLAUDE-rev.md— snippet agents load to know how to request reviews
systemd/           — user service unit for the always-on part
```

Single pnpm package on Node 26 — the server runs its TypeScript directly
(type stripping), no build step. Dev: `pnpm dev` (server + vite, proxied).
Prod: `pnpm build && pnpm start` — server serves `web/dist` statically.

## Server

- **git.ts** — shells out to `git`. Diff = `merge-base(base, HEAD)` →
  `git diff <mb>` against the *working tree* (not HEAD), plus untracked files
  from `git status --porcelain` rendered as added. Rename detection on.
  Output parsed into `FileDiff[]` (see types). Two cheaper views back the
  streamed UI: `computeDiffSummary` (numstat only — file list + stats, no
  content generated, near-constant cost) and `computeFileDiff` (one file's
  hunks, pathspec-limited).
- **semantic.ts** — entity-level diff ("function authenticate modified")
  via the optional [sem](https://github.com/Ataraxy-Labs/sem) CLI:
  `sem diff --format json <merge-base sha>` against the working tree,
  untracked files excluded. Binary missing/failing → `available: false`
  and the web UI falls back to its text heuristics. No rev-side cache —
  sem keeps its own and runs in ~20ms. Override the binary with
  `REV_SEM_BIN` (systemd PATH usually lacks `~/.local/bin`).
- **discovery.ts** — scans configured roots (default `~/tea`, `REV_ROOTS`)
  for `.git` dirs, then `git worktree list` from each to catch worktrees
  living outside the roots. Cached, re-scanned on demand and on a slow timer.
- **watcher.ts** — chokidar per repo *with at least one live viewer*
  (subscribed over WS), ignoring `.git/objects`, `node_modules`, build dirs.
  Debounced; emits `diff-invalidated` with the changed paths. Watching only
  viewed repos keeps the daemon cheap with dozens of repos discovered.
- **db.ts** — `node:sqlite` at `~/.local/share/rev/rev.db`. Tables: comments
  (threaded via `parentId`, resolvable), seen-state per (dir, base, file,
  contentHash). Content-hash is how "seen" survives refreshes and how
  staleness is detected.
- **routes.ts** — REST per `shared/types.ts`. No auth: LAN-trusted, same
  model as every other dev daemon on this box.

## Web

React 19 + Tailwind v4. TanStack Query for data with WS-driven invalidation
(`diff-invalidated` → refetch summary + touched file diffs; `comment-*` →
refetch comments). The review page loads `/api/diff/summary` first — the file
tree and headers paint immediately regardless of diff size — then each
expanded file fetches its own hunks (`/api/diff/file`) once it comes within
`HUNK_PREFETCH_MARGIN_PX` of the viewport, so opening a review never blocks
on the largest file. Wouter
for the two routes. Shiki (lazy, client-side) for syntax highlighting. The
diff renderer is ours — a library viewer can't host inline comment threads,
seen-tracking and inline editing the way we need.

## Agent loop

The agent's side of a review, documented in `agent/CLAUDE-rev.md`:

1. Push/commit (or not — working tree is enough), send the user
   `/review?dir=…&base=…`.
2. Long-poll `GET /api/comments?dir=…&since=<cursor>` for new comments.
3. Reply with `POST /api/comments` (`parentId` set, `author: "agent"`).
4. User sees replies in realtime over WS, resolves threads in the UI.

## Rejected along the way

- **Per-review server** — the problem statement. Port conflicts
  and lifecycle management are inherent to it.
- **Registering reviews server-side** (POST returns short id) — stateless
  URLs beat it: nothing to create, nothing to expire, agents can construct
  them without a round-trip. Short ids can be layered on later.
- **Watchman instead of chokidar** — better at scale, but a system dependency
  and daemon of its own; chokidar-on-viewed-repos is enough for a spike.
- **Server-side highlighting (Shiki on the wire)** — cleaner payloads but
  recomputes on every watcher tick; the client caches per file instead.
- **Diff library UI (diff2html, react-diff-view)** — fights inline widgets
  (comments, editing) and looks like every other diff. Own renderer.
- **Solid/Svelte for snappiness** — real, but agents iterate on this code;
  React keeps that friction lowest. Snappiness comes from virtualizing long
  diffs, not the framework.
- **Auth** — out of scope for a LAN spike; noted in README as a follow-up.
