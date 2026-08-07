# Decisions & open options

What the spike committed to, and the choices left open — ranked by how much
they change the daily workflow. Everything here works today unless marked
otherwise; "option" means a follow-up you can pick or drop.

## Settled (change = rework)

- **One daemon, stateless review URLs.** `/review?dir=<path>&base=<ref>`,
  merge-base computed per request, working tree included. No registration,
  no per-review lifecycle.
- **Own diff renderer** (server parses `git diff` to JSON, React renders).
  Libraries can't host inline threads / seen-state / quick-edit in the rows.
- **Comments in server SQLite** with a `seq` cursor and long-poll, so agents
  wait on comments instead of you relaying them.
- **Bun + Hono / React + Vite + Tailwind v4**, single package.

## Resolved during the overnight iteration (was "open")

- **Base freshness** — per-review "fetch base": the header shows how far
  local base lags its upstream (`baseBehind`) with a fetch button
  (`POST /api/fetch`). No background fetching, by design.
- **Comment lifetime vs base switch** — show-all: threads for the dir render
  regardless of base, tagged with a base chip when it differs.
- **Anchor durability** — server-side re-anchoring: anchors carry ±3 context
  lines; `GET /api/comments` returns `resolvedLine` located in the current
  working tree (snippet + context match), so threads follow the code.
  Orphans fall back to a per-file section.
- **Agent wake-up** — `scripts/rev-watch.sh` blocks on the long-poll so a
  session can arm it in the background and be re-invoked on new comments
  instead of holding a polling loop.
- **Diff-open latency** — was linear in diff size and blocked the whole view.
  Now summary-first: `/api/diff/summary` (numstat, no hunks) paints the tree
  instantly; each file streams its hunks via `/api/diff/file` when it nears
  the viewport. `/api/diff` (full) remains for API consumers.

## Sub-file seen segments (2026-08-02, removed 2026-08-03)

Marking parts of a file seen (`s`/`S` over the pointer collapsed block
bodies and comment runs into strips) shipped and was removed a day later:
the pointer-targeted block detection didn't work well in practice.
Seen-tracking is file-level only; the `seen_segments` table is dropped on
startup.

## Keyboard map vs vimium (2026-08-07)

- n/p rest the landed hunk at an eye-level anchor
  (`TUNING.HUNK_EYE_FRACTION`) with a hysteresis band. The old header-edge
  anchor gave p a zero-width threshold: the just-landed hunk sat exactly on
  it, so subpixel drift made p re-match in place (#66).
- d/u, gg/G and native f link-hints cover what the vimium extension provided,
  so vimium can be disabled for the rev origin without losing navigation.
  With vimium left enabled its bindings win (it captures first) — notably
  vimium's p (open clipboard URL) shadows rev's previous-hunk.
- e toggles the current file open/closed without touching seen; E expands
  every fold in the current file, and folds them all back once nothing is
  folded.

## Rejected for now (2026-08-02)

- **Reviewing refs that aren't checked out** (`head=<ref>` diffing the object
  DB). Decision: reviews target checked-out worktrees only; if a branch isn't
  available, check it out first. A future mechanism could let rev itself
  create the worktree from the UI (`git worktree add` on demand) — that path,
  not rev-mode diffing, is the preferred evolution. Prereq noted for then:
  comments should be keyed by repo (`mainDir`), not checkout dir, so threads
  are visible from every worktree of the same repo.

## Open — pick before building on the spike

1. **Quick edit widget.** Plain textarea today (no dependency, honest 409
   conflict handling). Option: CodeMirror 6 for syntax + search + multi-file.
   Worth it only if you find yourself editing more than a few lines.
2. **Auth.** None. Fine for the LAN; needed before any tunnel/exposure.
   A single bearer token in an env var + `?token=` bootstrap is a day of work.

## Known rough edges (accepted for the spike)

- Repos with untracked-but-not-ignored artifact dirs show huge changed-file
  counts (`bullish/mvp`: 389); per-file size cap keeps the diff usable.
  A `.revignore` or "hide untracked" toggle would clean this up.
- Oversize untracked files are listed with no hunks and empty contentHash —
  indistinguishable from empty files until `FileDiff` grows a `skipped` field.
- No diff virtualization within a file; files over 400 changed lines start
  collapsed instead. Total diff size no longer matters (per-file streaming),
  but a single monster file genuinely reviewed line by line still renders in
  one go.
- Split (side-by-side) view not built; unified only.
- `WATCH_IGNORE` matches directory names anywhere — a source dir literally
  named `build` would be invisible to watch/scan.
- chokidar v4 on Bun emits nothing for dotfile creation or mtime-only
  touches; content edits and normal-name adds work. Diff refresh can miss a
  brand-new dotfile until something else changes.

## Scope

rev covers local reviews only (this repo's `agent/CLAUDE-rev.md` is the
drop-in CLAUDE.md snippet). It deliberately doesn't touch forge PRs — use
the forge's own review UI for those.
