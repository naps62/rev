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

## Open — pick before building on the spike

1. **Base freshness.** Diffs use your local `main`. If origin moved and you
   haven't fetched, the diff is against an older main (correct locally,
   unlike a stale review server, but still not origin's truth).
   Option: server runs `git fetch` on the base remote every N minutes, or a
   per-review "fetch base" button. Recommend the button — background fetches
   in every repo will fight with agents mid-rebase.
2. **Comment lifetime vs base switch.** Comments are keyed (dir, base);
   switching base on the review page hides comments made under the other
   base. Options: show all comments for the dir regardless of base, or keep
   as is. Recommend show-all with a subtle base tag.
3. **Quick edit widget.** Plain textarea today (no dependency, honest 409
   conflict handling). Option: CodeMirror 6 for syntax + search + multi-file.
   Worth it only if you find yourself editing more than a few lines.
4. **Anchor durability.** Comments anchor to file+side+line+snippet; heavy
   edits above a comment can orphan it (it then shows in a per-file
   "couldn't re-anchor" section with its snippet). Option: hunk-context
   anchoring (store surrounding lines, re-match like `git apply` does).
   Recommend doing this once real reviews hit it.
5. **Auth.** None. Fine for the LAN; needed before any tunnel/exposure.
   A single bearer token in an env var + `?token=` bootstrap is a day of work.

## Known rough edges (accepted for the spike)

- Repos with untracked-but-not-ignored artifact dirs show huge changed-file
  counts (`bullish/mvp`: 389); per-file size cap keeps the diff usable.
  A `.revignore` or "hide untracked" toggle would clean this up.
- Oversize untracked files are listed with no hunks and empty contentHash —
  indistinguishable from empty files until `FileDiff` grows a `skipped` field.
- No diff virtualization; files over 400 changed lines start collapsed
  instead. Fine until a monster diff is genuinely reviewed line by line.
- Split (side-by-side) view not built; unified only.
- `WATCH_IGNORE` matches directory names anywhere — a source dir literally
  named `build` would be invisible to watch/scan.

## Scope

rev covers local reviews only (this repo's `agent/CLAUDE-rev.md` is the
drop-in CLAUDE.md snippet). It deliberately doesn't touch forge PRs — use
the forge's own review UI for those.
