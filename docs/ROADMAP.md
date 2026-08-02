# rev — build log

Nightshift spike, 2026-08-01. Spec: an always-on review server. See
ARCHITECTURE.md for the design and rejected options.

## Decisions

- **One prototype, one branch** — the spec allowed multiple option branches;
  chose a single polished prototype plus the "Rejected along the way" section
  in ARCHITECTURE.md. Two half-finished variants review worse than one that
  works end-to-end. (DECISIONS.md at the end summarizes the open choices.)
- **Node + Hono / React 19 + Vite + Tailwind v4** — plain Node 26 runs the
  TypeScript server directly; built-in `node:sqlite` and `node --test` keep
  deps small. (Originally Bun; migrated.)
- **Stateless review URLs** (`/review?dir&base`) — agents construct them with
  zero API calls.
- **Contract-first**: `shared/types.ts` frozen before implementation; both
  sides and the agent docs import/reference it.

## Milestones

- [x] M0 — architecture, contract, tuning, scaffold (typechecks clean)
- [ ] M1 — backend (git/discovery/watcher/db/routes/WS) + frontend
      (pages, diff renderer, comments UI) in parallel, disjoint files
  - [x] backend: 44 tests green (verified by architect re-run), live curl
        evidence for the whole REST/WS surface. Accepted deviations:
        /api/health added; isKnownRepo allows home ∪ roots; mode-only
        changes are hunkless "modified"; reply-to-reply flattens to root;
        nested independent repos undiscovered; WATCH_IGNORE matches names
        anywhere in a path.
  - [x] frontend: both routes, diff renderer with inline threads, seen/stale,
        quick edit with 409 handling, shiki async highlight, `?fixture` mode.
        Impeccable finish review ran (its fix batch applied); DESIGN.md
        skipped by the agent (outside its file ownership) — direction notes
        live in web/index.html.
- [x] M2 — integration, all against the live production server on this box:
        real-repo diff (pm-signer, 22 files) rendered correctly (screenshot),
        repo list with real worktrees (screenshot), WS diff-invalidated fired
        on live file write, comment long-poll woke on POST, agent reply +
        resolve worked, seen→stale flipped after an edit, SPA fallback served.
        Found live: discovery's git status bumped every index mtime (all
        repos "2m ago") → --no-optional-locks; basename collisions
        (pm-signer × 2) → root-relative names. Both fixed, tests still green.
- [x] M3 — DECISIONS.md, agent docs, systemd unit. Service installed and
        running on this machine (http://10.7.10.2:7373); kill -9 on the
        process was restarted by systemd within seconds (verified).
- [ ] M4 — gate, push, PR

## Contract debt (deliberate, for after the spike)

- `FileDiff` needs a `skipped`/`size` marker: oversize untracked files are
  listed with no hunks and `contentHash: ""`, indistinguishable from empty.
- Repos where `node_modules`/artifacts are untracked but not gitignored will
  flood the untracked list; only the per-file size cap protects us.

## Corrections

- The M5 tree-rail commit shipped an infinite-recursion crash (JSX spread
  overwrote `node` back to the parent in FileNav) that killed the renderer
  on any diff with a directory holding both files and a subdirectory —
  i.e. most real repos, including the pm-signer diff this project uses as
  its own demo. It passed verification because the fixture and livetest
  diffs happened to have only single-kind directories. Lesson recorded:
  fixtures must include a dir with files + subdir; verification of diff UIs
  must include at least one real multi-dir repo. Fixed in 5888203 after
  CDP-based bisection (profile → component ablation).
- The overnight session process died at ~22:30 and the scheduled wakeup died
  with it; ~7h of planned iteration was lost. The rev service itself ran
  uninterrupted all night. (Codex/live-agent testing and the M7 feature
  batch resumed at 05:30.)
